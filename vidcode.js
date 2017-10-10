"use strict";
const fs = require("fs");
const util = require("util");
const child_process = require("child_process");
const chokidar = require("chokidar");
const clone = require("clone");

const config = require("./vidcode.json");
const path = require("path");

const fs_open = util.promisify(fs.open);
const execFile_p = util.promisify(child_process.execFile);

let filename;

const watcher = chokidar.watch(config.watch, {
    persistent: true,
    followSymlinks: false,
    usePolling: true,
    depth: undefined,
    interval: 100,
    ignorePermissionErrors: false
});

watcher.on('add', async (_filename) => {
    filename = _filename;
    await waitForCopyComplete(filename);
    const streamData = await ffProbeData(filename);
    const sourceStreams = parseStreams(streamData);
    const selectedVideo = selectVideoStream(sourceStreams.video);
    console.info("Video stream selected: ");
    console.info(selectedVideo.map((s) => s.index));
    const selectedAudio = selectAudioStreams(sourceStreams.audio);
    console.info("Audio stream(s) selected: ");
    console.info(selectedAudio.map((s) => s.index));
    const selectedSubtitles = await selectSubtitleStreams(sourceStreams.subtitle);
    console.info("Subtitle(s) selected: ");
    console.info(selectedSubtitles.map((s) => s.index));
    const selectedStreams = {
        video: selectedVideo,
        audio: selectedAudio,
        subtitle: selectedSubtitles,
    };
    const ffmpegOptions = createConversionOptions(selectedStreams);
    await doConversion(ffmpegOptions);
    moveSourceFile(filename);
});

async function waitForCopyComplete(path) {
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
            const fd = await fs_open(path, "a+");
            fs.closeSync(fd);
            return path;
        } catch (err) {
            console.info(`Waiting ${WAIT_INTERVAL_MILLIS} ms`);
            await delayCheck(WAIT_INTERVAL_MILLIS);
        }
        total_wait += WAIT_INTERVAL_MILLIS;
    } while (total_wait < MAX_WAIT_MILLIS);
    console.warn(`checkFileCopyComplete exceeded MAX_WAIT_MILLIS (${MAX_WAIT_MILLIS}`);
}

function parseStreams(streams) {
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
    console.info(filename);
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
            { cwd: config.watch },
        );
        return JSON.parse(execResult.stdout);
    } catch (err) {
        console.error("Error executing ffprobe:");
        console.error(err);
        throw err;
    }
}

function selectVideoStream(streamArray) {
    if (streamArray.length === 1) {
        return streamArray;
    } else {
        return processVideoSelectors(streamArray);
    }
}

function processVideoSelectors(streamArray) {
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
    let selected = [];
    switch(rule.resolution) {
        case "min":
            let min = streamArray.reduce((a, b) => {
                return Math.min(a.width, b.width);
            });
            selected = streamArray.find((s) => {
                s.width = min.width;
            });
            break;
        case "max":
            let max = streamArray.reduce((a, b) => {
                return Math.max(a.width, b.width);
            });
            selected = streamArray.find((s) => {
                s.width = max.width;
            });
            break;
        default:
            if (!isNan(rule.resolution)) {
                selected = streamArray.find((s) => {
                    // noinspection EqualityComparisonWithCoercionJS
                    return s.width == rule.resolution;
                })
            }
            break;
    }
    return selected;
}

function selectVideoDuration(streamArray, rule) {
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
            let min = tempStreamArray.reduce((a, b) => {

                return Math.min(a.duration, b.duration);
            });
            selected = tempStreamArray.find((s) => {
                s.duration = min.duration;
            });
            break;
        case "max":
            let max = tempStreamArray.reduce((a, b) => {
                return Math.max(a.duration, b.duration);
            });
            selected = tempStreamArray.find((s) => {
                s.duration = max.duration;
            });
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
    console.info("Desired language tags:");
    rule.language.forEach((tag) => console.info(tag));
    return streamArray.filter((x) => {
        return rule.language.includes(x.tags.language);
    })
}

function selectAudioCodec(streamArray, rule) {
    console.info("Desired audio codecs:");
    rule.codec.forEach((tag) => console.info(`Codec: ${tag}`));
    return streamArray.filter((x) => {
        return rule.codec.includes(x.codec_name);
    })
}

async function selectSubtitleStreams(streamArray) {
    console.info("Selecting subtitle streams");
    if (streamArray.length === 1) {
        console.info("One stream in source, selecting by default");
        return streamArray;
    } else {
        console.info("Processing subtitle selection rules");
        return await processSubtitleSelectors(streamArray);
    }
}

/** Process the stream array according to the subtitle selection rules
 *  Subtitles can have multiple sets of rules, so expects the rule list to be
 *  an array of arrays.
 * @param streamArray
 * @returns {*}
 */
async function processSubtitleSelectors(streamArray) {
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
                    selected = await selectSubtitleForeignAudio(selected);
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
    console.info("Desired language tags:");
    rule.language.forEach((tag) => console.info(tag));
    return streamArray.filter((x) => {
        return rule.language.includes(x.tags.language);
    })
}

async function selectSubtitleForeignAudio(streamArray) {
    console.info("Foreign audio search:");

    try {
        const subtitleCounts = await searchForeignAudio(streamArray);
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

async function searchForeignAudio(streams) {
    const chunk = 4;
    const results = [];
    let loop = 1;
    for (let i=0; i < streams.length; i += chunk) {
        console.info(`getting subs chunk ${loop++}`);
        try {
            const streamChunk = streams.slice(i, i+chunk);
            const result = await countSubtitlesChunked(streamChunk);
            results.concat(results, result);
        } catch (exc) {
            console.err(exc);
        }
    }
    return results;
}

async function countSubtitlesChunked(streams) {
    return Promise.all(
        streams.map(async (stream) => {
            try {
                const sub = await ffMpegExtractSubtitle(filename, stream.index);
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
    console.info("Desired codec:");
    rule.codec.forEach((tag) => console.info(tag));
    return streamArray.filter((x) => {
        return rule.codec.includes(x.codec_name);
    });
}

async function ffMpegExtractSubtitle(filename, streamId) {
    const execFile_p = util.promisify(child_process.execFile);
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
                'srt',
                'pipe:1'
            ],
            {
                cwd: config.watch,
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

function createConversionOptions(selectedStreams) {
    const options = config.output.global.options;
    return options.concat(
        "-i", filename,
        createMapOptions(selectedStreams),
        createVideoOptions(selectedStreams.video),
        createAudioOptions(selectedStreams.audio),
        createSubtitleOptions(selectedStreams.subtitle),
        createOutputFilename());
}

function createMapOptions(streams) {
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
    for (const subtitleStream of streams.subtitle) {
        maps.push("-map", `0:${subtitleStream.index}`);
    }
    return maps;
}

function createVideoOptions() {
    return [].concat(
        "-c:v", config.output.video.encoder,
        config.output.video.options
    );
}

function createAudioOptions() {
    return [].concat(
        "-c:a", config.output.audio.encoder,
        config.output.audio.options
    );
}

function createSubtitleOptions() {
    return [].concat(
        "-c:s", config.output.subtitle.encoder,
        config.output.subtitle.options
    );
}

function createOutputFilename() {
    const outFilename = path.basename(filename, path.extname(filename)) + ".mkv";
    return path.join(
        config.output.global.path,
        outFilename)
}

async function doConversion(options) {
    const startTime = process.hrtime();
    try {
        const execResult = await execFile_p(
            'ffmpeg',
            options,
            {
                cwd: config.watch,
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

function moveSourceFile() {
    if (!fs.existsSync(config.source_destination)) {
        try {
            fs.mkdirSync(config.source_destination);
        } catch (err) {
            console.error(`Could not create source file destination directory ${config.source_destination}.`);
            console.error(err.reason);
        }
    }
    const destFilename = path.join(
        config.source_destination,
        path.basename(filename),
    );
    try {
        fs.renameSync(filename, destFilename);
    } catch (err) {
        console.error(`Could not move source file to destination directory ${config.source_destination}.`);
        console.error(err.reason);
    }
}