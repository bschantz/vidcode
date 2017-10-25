const fs = require("fs");
const util = require("util");
const child_process = require("child_process");
const chokidar = require("chokidar");
const clone = require("clone");
const queue = require("promise-queue");
const moment = require("moment");
require("moment-duration-format");

const config = require("./vidcode.json");
const path = require("path");

const fs_open = util.promisify(fs.open);
const execFile_p = util.promisify(child_process.execFile);
const readFile_p = util.promisify(fs.readFile);
const writeFile_p = util.promisify(fs.writeFile);

const imageSubs = [
    "hdmv_pgs_subtitle",
    "dvd_subtitle"
];

process.on('unhandledRejection', (reason) => {
    "use strict";
    console.error(reason);
});

const watcher = chokidar.watch(config.paths.watch, {
    persistent: true,
    followSymlinks: false,
    usePolling: true,
    depth: 1,
    interval: 100,
    ignorePermissionErrors: false,
    awaitWriteFinish: false
});

const processorQueue = new queue(1, Infinity);

watcher.on('add', async (_filename) => {
    console.log(`Watcher saw ${_filename}`);
    // don't add file multiple times
    watcher.unwatch(_filename);
    await waitForCopyComplete(_filename);

    console.log(`Adding ${_filename} to process queue`);
    processorQueue.add(await transcode.bind(null, _filename))
        .then((result) => {
            "use strict";
            console.log("processing complete");
            console.log(result);
        });
});

async function transcode(filename) {
    "use strict";
    console.log(`Processing ${filename} from queue`);
    return await processVideo(filename);
}

async function processVideo(filename) {
    console.warn(`${arguments.callee.name}: ${filename}`);
    const processFile = moveToProcessDirectory(filename);
    const streamData = await ffProbeData(processFile);
    const sourceStreams = parseStreams(streamData);
    const selectedVideo = selectVideoStream(sourceStreams.video);
    console.info("Video stream selected: ");
    console.info(selectedVideo.map((s) => s.index));
    const selectedAudio = selectAudioStreams(sourceStreams.audio);
    console.info("Audio stream(s) selected: ");
    console.info(selectedAudio.map((s) => s.index));
    const selectedSubtitles = await selectSubtitleStreams(sourceStreams.subtitle, processFile);
    console.info("Subtitle(s) selected: ");
    console.info(selectedSubtitles.map((s) => s.index));
    const selectedStreams = {
        video: selectedVideo,
        audio: selectedAudio,
        subtitle: selectedSubtitles,
    };
    const ffmpegOptions = createConversionOptions(selectedStreams, processFile);
    await doConversion(ffmpegOptions);
    backupSourceFile(processFile);
}

async function waitForCopyComplete(path) {
    console.warn(`${arguments.callee.name}: ${path}`);
    try {
        return await checkFileCopyComplete(path);
    } catch (err) {
        console.error(err);
        throw err;
    }
}

function delayCheck(wait) {
    return new Promise((resolve) => {
        setTimeout(() => resolve(), wait);
    });
}

async function checkFileCopyComplete(path) {
    const MAX_WAIT_MILLIS = 1000 * 60 * 60 * 4;
    const WAIT_INTERVAL_MILLIS = 2000;
    let total_wait = 0;
    do {
        try {
            const fd = await fs_open(path, "r");
            fs.closeSync(fd);
            console.log(`Done: ${path}`);
            return path;
        } catch (err) {
            process.stdout.write(".");
            await delayCheck(WAIT_INTERVAL_MILLIS);
        }
        total_wait += WAIT_INTERVAL_MILLIS;
    } while (total_wait < MAX_WAIT_MILLIS);
    console.warn(`checkFileCopyComplete exceeded MAX_WAIT_MILLIS (${MAX_WAIT_MILLIS}`);
}

function parseStreams(streams) {
    console.warn(arguments.callee.name);
    const video_streams = streams.streams.filter((x) => x.codec_type === "video");
    const audio_streams = streams.streams.filter((x) => x.codec_type === "audio");
    const subtitle_streams = streams.streams.filter((x) => x.codec_type === "subtitle");
    return {
        video: video_streams,
        audio: audio_streams,
        subtitle: subtitle_streams,
    };
}

async function ffProbeData(filename) {
    console.warn(`${arguments.callee.name}: ${filename}`);
    const execFile_p = util.promisify(child_process.execFile);
    try {
        const execResult = await execFile_p('ffprobe',
            [
                '-print_format',
                'json',
                '-show_format',
                '-show_streams',
                filename
            ],
            { cwd: config.paths.watch },
        );
        return JSON.parse(execResult.stdout);
    } catch (err) {
        console.error("Error executing ffprobe:");
        console.error(err);
        throw err;
    }
}

function selectVideoStream(streamArray) {
    console.warn(`${arguments.callee.name}`);
    if (streamArray.length === 1) {
        return streamArray;
    } else {
        return processVideoSelectors(streamArray);
    }
}

function processVideoSelectors(streamArray) {
    console.warn(arguments.callee.name);
    const rules = config.selection.video;
    let selected = streamArray;
    for (const rule of rules) {
        // only one left, no need to continue processing rules
        if (selected.length === 1) {
            break;
        }
        const key = Object.keys(rule)[0];
        switch(key) {
            case "resolution":
                selected = selectVideoResolution(selected, rule);
                break;
            case "duration":
                selected = selectVideoDuration(selected, rule);
                break;
            case "codec":
                break;
        }
    }
    return selected;
}

function selectVideoResolution(streamArray, rule) {
    console.warn(arguments.callee.name);
    let selected = [];
    switch(rule.resolution) {
        case "min":
            const min = streamArray.reduce((a, b) => {
                return Math.min(a, b.width);
            }, Infinity);
            const minRes = streamArray.filter((s) => {
                return s.width === min;
            });
            selected = minRes || selected;
            break;
        case "max":
            const max = streamArray.reduce((a, b) => {
                return Math.max(a, b.width);
            }, 0);
            const maxRes = streamArray.filter((s) => {
                return s.width === max;
            });
            selected = maxRes || selected;
            break;
        default:
            if (!isNaN(rule.resolution)) {
                selected = streamArray.filter((s) => {
                    return s.width === rule.resolution;
                })
            }
            break;
    }
    return selected;
}

function selectVideoDuration(streamArray, rule) {
    console.warn(arguments.callee.name);
    let selected;
    // duration may not be an attribute of the stream, so check for tags
    let tempStreamArray = streamArray.map((i) => {
        if (i.duration && !isNaN(i.duration)) {
            return i;
        }
        if (i.tags && i.tags.NUMBER_OF_FRAMES) {
            i.duration = i.tags.NUMBER_OF_FRAMES;
            return i;
        }
    });
    switch(rule.duration) {
        case "min":
            let min = tempStreamArray.reduce((accumulator, nextValue) => {

                return Math.min(accumulator, nextValue.duration);
            }, Infinity);
            selected = tempStreamArray.filter((s) => {
                return s.duration === min.duration;
            });
            break;
        case "max":
            let max = tempStreamArray.reduce((accumulator, nextValue) => {
                return Math.max(accumulator, nextValue.duration);
            });
            selected = tempStreamArray.filter((s) => {
                return s.duration === max.duration;
            }, 0);
            break;
        default:
            throw new Error(`Invalid config value: ${rule.duration} is not a valid duration specifier.`);
            break;
    }
    return streamArray.filter((s) => {
        return (-1 !== selected.findIndex((x) => x.index === s.index));
    })
}

function selectAudioStreams(streamArray) {
    console.warn(`${arguments.callee.name}`);
    console.info("Selecting audio streams");
    if (streamArray.length === 1) {
        console.info("One stream in source, selecting by default");
        return streamArray;
    } else {
        console.info("Processing audio selection rules");
        return processAudioSelectors(streamArray);
    }
}

function processAudioSelectors(streamArray) {
    console.warn(`${arguments.callee.name}`);
    const rules = config.selection.audio;
    let selected = streamArray;
    for (const rule of rules) {
        // only one left, no need to continue processing rules
        if (selected.length === 1) {
            break;
        }
        const key = Object.keys(rule)[0];
        switch(key) {
            case "language":
                console.info("Selecting audio by language:");
                selected = selectAudioLanguage(selected, rule);
                break;
            case "codec":
                console.info("Selecting audio by codec:");
                selected = selectAudioCodec(selected, rule);
                break;
        }
    }
    return selected;
}

function selectAudioLanguage(streamArray, rule) {
    console.warn(arguments.callee.name);
    console.info("Desired language tags:");
    rule.language.forEach((tag) => console.info(tag));
    return streamArray.filter((x) => {
        return rule.language.includes(x.tags.language);
    })
}

function selectAudioCodec(streamArray, rule) {
    console.warn(`${arguments.callee.name}`);
    console.info("Desired audio codecs:");
    rule.codec.forEach((tag) => console.info(`Codec: ${tag}`));
    return streamArray.filter((x) => {
        return rule.codec.includes(x.codec_name);
    })
}

async function selectSubtitleStreams(streamArray, mediaFile) {
    console.warn(`${arguments.callee.name}`);
    console.info("Selecting subtitle streams");
    let subtitleStreams;
    if (streamArray.length === 1) {
        console.info("One stream in source, selecting by default");
        subtitleStreams = streamArray;
    } else {
        console.info("Processing subtitle selection rules");
        subtitleStreams =  await processSubtitleSelectors(streamArray, mediaFile);
    }
    // check for bitmap subtitles
    return await checkImageSubtitles(subtitleStreams, mediaFile);
}

async function checkImageSubtitles(streams, mediaFile) {
    console.warn(`${arguments.callee.name}`);
    for (let i = 0, ii = streams.length; i < ii; i++) {
        const stream = streams[i];
        if (imageSubs.includes(stream.codec_name)) {
            let srtFile = await convertSubToSRT(stream, mediaFile);
            console.info(`Generated SRT file ${srtFile}`);
            streams[i].subFile = srtFile;
        }
    }
    return streams;
}

async function convertSubToSRT(stream, mediaFile) {
    console.warn(`${arguments.callee.name}`);
    const srtFileName = path.join(config.paths.process, `sub_${stream.index}.srt`);
    const ocrFile = `sub_ocr_${stream.index}.txt`;

    const execFile_p = util.promisify(child_process.execFile);
    try {
        await execFile_p('ffmpeg',
            [
                '-y', '-v', 'error',
                '-hwaccel', 'cuvid',
                '-nostdin',
                '-i', mediaFile, '-an',
                '-filter_complex', `[0:s]ocr,metadata=key=lavfi.ocr.text:mode=print:file=${ocrFile},null`,
                '-c:v', 'hevc_nvenc', '-rc:v', '1000', '-cbr', 'true',
                'dummy.mkv'
            ],
            {
                cwd: config.paths.process,
                maxBuffer: 400 * 1024,
            },
        );
    } catch (e) {
        console.error(e);
        throw e;
    }
    const srtData = await parseOcrFile(path.join(config.paths.process, ocrFile));
    await writeFile_p(srtFileName, srtData);
    try {
        fs.unlinkSync(path.join(config.paths.process, 'dummy.mkv'));
        fs.unlinkSync(path.join(config.paths.process, ocrFile));
    } catch (err) {
        /* errors ok here */
        console.warn(err);
    }
    return srtFileName;
}

async function parseOcrFile(filename) {
    "use strict";
    const stream = await readFile_p(filename);

    const parser = new ocrParser(stream.toString());

    return parser.parse();
}

/** Process the stream array according to the subtitle selection rules
 *  Subtitles can have multiple sets of rules, so expects the rule list to be
 *  an array of arrays.
 * @param streamArray
 * @param mediaFile {string}
 * @returns {*}
 */
async function processSubtitleSelectors(streamArray, mediaFile) {
    console.warn(`${arguments.callee.name}`);
    const ruleSets = config.selection.subtitle;
    let streams = clone(streamArray);
    let selectedStreams = [];
    for (const rules of ruleSets) {
        let selected = streams;
        for (const rule of rules) {
            // only one left, no need to continue processing rules
            if (selected.length === 1) {
                break;
            }
            const key = Object.keys(rule)[0];
            switch (key) {
                case "language":
                    console.info("Selecting subtitle by language:");
                    selected = selectSubtitleLanguage(selected, rule);
                    break;
                case "foreign":
                    console.info("Selecting subtitle by foreign audio search:");
                    selected = await selectSubtitleForeignAudio(selected, mediaFile);
                    break;
                case "codec":
                    console.info("Selecting subtitle by codec:");
                    selected = selectSubtitleCodec(selected, rule);
                    break;
            }
        }
        // now remove the selected streams from the source streams so they aren't selected twice
        streams = streams.filter((s) => {
            return ( selected.find((i) => i.index === s.index) === undefined);
        });
        selectedStreams = selectedStreams.concat(selected);
    }
    return selectedStreams;
}

function selectSubtitleLanguage(streamArray, rule) {
    console.warn(`${arguments.callee.name}`);
    console.info("Desired language tags:");
    rule.language.forEach((tag) => console.info(tag));
    return streamArray.filter((x) => {
        return rule.language.includes(x.tags.language);
    })
}

async function selectSubtitleForeignAudio(streamArray, mediaFile) {
    console.warn(`${arguments.callee.name}`);
    console.info("Foreign audio search:");

    try {
        const subtitleCounts = await searchForeignAudio(streamArray, mediaFile);
        let maxEntries = 0;

        // sort descending
        subtitleCounts.sort((a, b) => {
            return b[0] - a[0];
        });

        maxEntries = subtitleCounts[0] ? subtitleCounts[0][0] : 0;

        // filter all subs with 25% or fewer entries, then map
        // the result to just the stream objects
        return subtitleCounts.filter((s) => {
            return s[0] > 0 && s[0] < maxEntries / 4.0;
        }).map((s) => s[1]);
    } catch (err) {
        console.error("Error in 'selectSubtitleForeignAudio'");
        console.error(err);
        throw err;
    }
}

async function searchForeignAudio(streams, mediaFile) {
    console.warn(`${arguments.callee.name}`);
    const chunk = 4;
    const results = [];
    let loop = 1;
    for (let i=0; i < streams.length; i += chunk) {
        console.info(`getting subs chunk ${loop++}`);
        try {
            const streamChunk = streams.slice(i, i+chunk);
            const result = await countSubtitlesChunked(streamChunk, mediaFile);
            results.concat(results, result);
        } catch (exc) {
            console.err(exc);
        }
    }
    return results;
}

async function countSubtitlesChunked(streams, mediaFile) {
    console.warn(`${arguments.callee.name}`);
    return Promise.all(
        streams.map(async (stream) => {
            try {
                const sub = await ffMpegExtractSubtitle(mediaFile, stream.index, stream.codec_name);
                const matches = sub.match(/(\d+(?=\n\d\d:\d\d:\d\d,\d+))/g);
                const count = matches ? matches.length : 0;
                return [count, stream];
            } catch (exc) {
                console.error(exc);
                return Promise.reject(exc);
            }
        })
    );
}

function selectSubtitleCodec(streamArray, rule) {
    console.warn(arguments.callee.name);
    console.info("Desired codec:");
    rule.codec.forEach((tag) => console.info(tag));
    return streamArray.filter((x) => {
        return rule.codec.includes(x.codec_name);
    });
}

async function ffMpegExtractSubtitle(filename, streamId, codec) {
    console.warn(`${arguments.callee.name}`);
    const execFile_p = util.promisify(child_process.execFile);

    // map codec to output format
    const format = mapSubtitleCodecToFormat(codec);
    try {
        const execResult = await execFile_p('ffmpeg',
            [
                '-v',
                'error',
                '-nostdin',
                '-i',
                filename,
                '-map',
                `0:${streamId}:0`,
                '-f',
                `${format}`,
                'pipe:1'
            ],
            {
                cwd: config.paths.process,
                maxBuffer: 400 * 1024,
            },
        );
        console.info(`stderr: ${execResult.stderr}`);
        return execResult.stdout;
    } catch (err) {
        console.error("Error executing ffmpeg:");
        console.error(err);
        throw err;
    }
}

function mapSubtitleCodecToFormat(codec) {
    "use strict";
    const formats = {
        'dvd_subtitle': 'dvd',
    };
    return formats[codec] || codec;
}

function createConversionOptions(selectedStreams, mediaFile) {
    console.warn(`${arguments.callee.name}`);
    let options = config.output.global.options;
    options = options.concat("-i", mediaFile);
    let externalSubs = getExternalSubsInput(selectedStreams.subtitle);
    if (externalSubs !== false) {
        options = options.concat(externalSubs);
    }
    return options.concat(
        createMapOptions(selectedStreams),
        createVideoOptions(selectedStreams.video),
        createAudioOptions(selectedStreams.audio),
        createSubtitleOptions(selectedStreams.subtitle),
        createOutputFilename(mediaFile)
    );
}

function getExternalSubsInput(streams) {
    let externalSubOptions = [];
    for(const stream of streams) {
        if (stream.subFile) {
            externalSubOptions.push("-i", stream.subFile);
        }
    }
    return externalSubOptions.length > 0 ? externalSubOptions : false;
}

function createMapOptions(streams) {
    console.warn(`${arguments.callee.name}`);
    const maps = [];

    // map video
    for (const videoStream of streams.video) {
        maps.push("-map", `0:${videoStream.index}`);
    }

    // map audio
    for (const audioStream of streams.audio) {
        maps.push("-map", `0:${audioStream.index}`);
    }

    // map subtitles
    let externalSubIndex = 1;
    for (const subtitleStream of streams.subtitle) {
        if (subtitleStream.subFile) {
            maps.push("-map", `${externalSubIndex++}:0`);
        } else {
            maps.push("-map", `0:${subtitleStream.index}`);
        }
    }
    return maps;
}

function createVideoOptions() {
    console.warn(`${arguments.callee.name}`);
    return [].concat(
        "-c:v", config.output.video.encoder,
        config.output.video.options
    );
}

function createAudioOptions() {
    console.warn(`${arguments.callee.name}`);
    return [].concat(
        "-c:a", config.output.audio.encoder,
        config.output.audio.options
    );
}

function createSubtitleOptions() {
    console.warn(`${arguments.callee.name}`);
    return [].concat(
        "-c:s", config.output.subtitle.encoder,
        config.output.subtitle.options
    );
}

function createOutputFilename(sourceFile) {
    console.warn(`${arguments.callee.name}`);
    const outFilename = path.basename(sourceFile, path.extname(sourceFile)) + ".mkv";
    return path.join(
        config.paths.output,
        outFilename)
}

async function doConversion(options) {
    console.warn(`${arguments.callee.name}`);
    const startTime = process.hrtime();
    try {
        const execResult = await execFile_p(
            'ffmpeg',
            options,
            {
                cwd: config.paths.watch,
                maxBuffer: 400 * 1024,
            },
        );
        const endTime = process.hrtime(startTime);
        console.info(endTime);
        const minutes = Math.floor(endTime[0] / 60);
        const seconds = Math.floor(endTime[0] % 60);
        console.info("Conversion took %dm %ds.%d", minutes, seconds, Math.round(endTime[1]/1000000));
        return execResult.stderr;
    } catch (err) {
        console.error("doConversion: error executing ffmpeg:");
        console.error(err);
        throw err;
    }
}

function moveToProcessDirectory(sourceFile) {
    console.warn(`${arguments.callee.name}`);
    return moveFile(sourceFile, config.paths.process);
}

function backupSourceFile(sourceFile) {
    console.warn(`${arguments.callee.name}`);
    moveFile(sourceFile, config.paths.backup)
}

function moveFile(source, destination) {
    console.warn(`${arguments.callee.name}`);
    if (!fs.existsSync(destination)) {
        try {
            fs.mkdirSync(destination);
        } catch (err) {
            console.error(`Could not create source file destination directory ${destination}.`);
            console.error(err.reason);
        }
    }
    const destinationFilename = path.join(
        destination,
        path.basename(source),
    );
    try {
        fs.renameSync(source, destinationFilename);
    } catch (err) {
        console.error(`Could not move source file to destination directory ${destination}.`);
        console.error(err.reason);
    }
    return destinationFilename;
}

class ocrParser {
    constructor(inputText) {
        this.textTag = 'lavfi.ocr.text=';
        this.inputLines = inputText.split("\n");

        this.currentLine = 0;
        this.currentSubtitleIndex = 1;
        this.endOfInput = false;
    }

    parse() {
        let rawFrame;
        let subtitleFrame;
        let srtText = '';
        while (!this.endOfInput && (rawFrame = this.readRawFrame())) {
            if (rawFrame.text && rawFrame.text.trim() !== '') {
                subtitleFrame = this.initSubtitleFrame();
                subtitleFrame.startTime = moment
                    .duration(rawFrame.time, "seconds")
                    .format("HH:mm:ss,SSS", { precision: 0, trim: false });

                subtitleFrame.text = rawFrame.text;

                rawFrame = this.readRawFrame();
                if (!rawFrame) {
                    // unexpected end of input - just discard the incomplete subtitle
                    // frame and use what we have.
                    break;
                }
                subtitleFrame.endTime = moment
                    .duration(rawFrame.time, "seconds")
                    .format("HH:mm:ss,SSS", { precision: 0, trim: false });

                srtText += `${subtitleFrame.index}\n`;
                srtText += `${subtitleFrame.startTime} --> ${subtitleFrame.endTime}\n`;
                srtText += `${subtitleFrame.text}\n\n`;
            }
        }

        return srtText;
    }

    readRawFrame() {
        const nextFrame = ocrParser.initRawFrame();

        let nextLine;
        if (false !== (nextLine = this.getLine())) {
            nextLine.split(/\s+/).forEach((piece) => {
                const x = piece.split(":");
                switch (x[0]) {
                    case 'frame':
                        nextFrame.index = x[1];
                        break;
                    case 'pts_time':
                        nextFrame.time = parseFloat(x[1]);
                        break;
                }
            });
        } else {
            // end of file
            return null;
        }

        nextFrame.text = '';
        if ((false !== (nextLine = this.getLine())) && nextLine.startsWith(this.textTag)) {
            nextFrame.text += nextLine.trim().substring(this.textTag.length);
        } else {
            // frame without a text tag is invalid
            throw new Error(`Invalid frame format at index ${this.currentLine}`);
        }

        while (true) {
            nextLine = this.peekLine();
            if (nextLine === false) {
                // end of file -
                this.endOfInput = true;
                break;
            }

            if (nextLine.startsWith('frame:')) {
                // beginning of new frame - do not increment line counter
                break;
            }
            this.currentLine++;

            if (nextLine.trim().length > 0) {
                nextFrame.text += '\n' + nextLine;
            }
        }

        return nextFrame;
    }

    getLine() {
        const line = this.inputLines[this.currentLine++];
        return line === undefined ? false : line;
    }

    peekLine() {
        const line = this.inputLines[this.currentLine];
        return line === undefined ? false : line;
    }

    static initRawFrame() {
        return {
            index: -1,
            time: -1,
            text: null,
        }
    }

    initSubtitleFrame() {
        return {
            index: this.currentSubtitleIndex++,
            startTime: null,
            endTime: null,
            text: null,
        }
    }
}