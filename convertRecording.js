const fs = require("fs");
const path = require("path");
const os = require("os");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId:
      process.env.RECORDING_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey:
      process.env.RECORDING_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function streamToFile(stream, filePath) {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);
    stream.pipe(writeStream);
    stream.on("error", reject);
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });
}

function convertMp4ToM4a(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("aac")
      .audioBitrate("128k")
      .audioFrequency(44100)
      .audioChannels(1)
      .outputOptions(["-movflags +faststart"])
      .format("ipod")
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}

function convertMp4ToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .audioFrequency(44100)
      .audioChannels(1)
      .format("mp3")
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}

async function convertS3Mp4ToM4a({ bucket, mp4Key }) {
  const baseName = path.basename(mp4Key, path.extname(mp4Key));
  const folder = path.dirname(mp4Key);

  const m4aKey = `${folder}/${baseName}.m4a`;
  const mp3Key = `${folder}/${baseName}.mp3`;

  const tempMp4 = path.join(os.tmpdir(), `${baseName}.mp4`);
  const tempM4a = path.join(os.tmpdir(), `${baseName}.m4a`);
  const tempMp3 = path.join(os.tmpdir(), `${baseName}.mp3`);

  console.log("Downloading MP4 from S3:", mp4Key);

  const getResult = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: mp4Key,
    })
  );

  await streamToFile(getResult.Body, tempMp4);

  console.log("Converting MP4 to M4A:", tempM4a);
  await convertMp4ToM4a(tempMp4, tempM4a);

  console.log("Converting MP4 to MP3:", tempMp3);
  await convertMp4ToMp3(tempMp4, tempMp3);

  console.log("Uploading M4A to S3:", m4aKey);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: m4aKey,
      Body: fs.readFileSync(tempM4a),
      ContentType: "audio/mp4",
    })
  );

  console.log("Uploading MP3 to S3:", mp3Key);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: mp3Key,
      Body: fs.readFileSync(tempMp3),
      ContentType: "audio/mpeg",
    })
  );

  fs.unlinkSync(tempMp4);
  fs.unlinkSync(tempM4a);
  fs.unlinkSync(tempMp3);

  return {
    m4aKey,
    mp3Key,
    m4aUrl: `https://${bucket}.s3.${
      process.env.AWS_REGION || "us-east-1"
    }.amazonaws.com/${m4aKey}`,
    mp3Url: `https://${bucket}.s3.${
      process.env.AWS_REGION || "us-east-1"
    }.amazonaws.com/${mp3Key}`,
  };
}

module.exports = {
  convertS3Mp4ToM4a,
};