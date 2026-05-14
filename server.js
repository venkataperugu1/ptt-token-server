const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");
const {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");

const { convertS3Mp4ToM4a } = require("./convertRecording");

dotenv.config();

const app = express();
app.use(express.json());

app.use(cors());
const APP_ID = process.env.APP_ID;
const APP_CERTIFICATE = process.env.APP_CERTIFICATE;
const CUSTOMER_ID = process.env.AGORA_CUSTOMER_ID;
const CUSTOMER_SECRET = process.env.AGORA_CUSTOMER_SECRET;
const PORT = process.env.PORT || 3000;

const BASE_URL = "https://api.sd-rtn.com";
const MODE = "mix";

const activeRecordings = new Map();

const RECORDING_BUCKET =
  process.env.RECORDING_BUCKET ||
  process.env.AWS_BUCKET_NAME ||
  "ptt-mobile-s3-new";

const AWS_REGION = process.env.AWS_REGION || "us-east-1";

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId:
      process.env.RECORDING_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey:
      process.env.RECORDING_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
  },
});

function forceMp3Key(key) {
  if (!key) return "";
  return key
    .replace(/\.mp4$/i, ".mp3")
    .replace(/\.m4a$/i, ".mp3");
}

function getContentType(key) {
  if (key.endsWith(".mp3")) return "audio/mpeg";
  if (key.endsWith(".m4a")) return "audio/mp4";
  if (key.endsWith(".mp4")) return "video/mp4";
  if (key.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (key.endsWith(".ts")) return "video/mp2t";
  return "application/octet-stream";
}

// ================= HEALTH =================
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

// ================= TOKEN =================
app.get("/token", (req, res) => {
  try {
    const { channelName, uid } = req.query;

    if (!channelName) {
      return res.status(400).json({ error: "Missing channelName" });
    }

    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID,
      APP_CERTIFICATE,
      channelName,
      Number(uid || 0),
      RtcRole.PUBLISHER,
      Math.floor(Date.now() / 1000) + 3600
    );

    res.json({ token, appId: APP_ID });
  } catch (e) {
    console.error("TOKEN ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// ================= START RECORDING =================
app.post("/start-recording", async (req, res) => {
  try {
    const { channelName } = req.body;

    if (!channelName) {
      return res.status(400).json({ error: "Missing channelName" });
    }

    if (activeRecordings.has(channelName)) {
      return res.json({
        ok: true,
        message: "Recording already active",
      });
    }

    const recordingUid = "9999";

    const acquire = await axios.post(
      `${BASE_URL}/v1/apps/${APP_ID}/cloud_recording/acquire`,
      {
        cname: channelName,
        uid: recordingUid,
        clientRequest: {},
      },
      { auth: { username: CUSTOMER_ID, password: CUSTOMER_SECRET } }
    );

    const resourceId = acquire.data.resourceId;

    const recordingToken = RtcTokenBuilder.buildTokenWithUid(
      APP_ID,
      APP_CERTIFICATE,
      channelName,
      Number(recordingUid),
      RtcRole.PUBLISHER,
      Math.floor(Date.now() / 1000) + 3600
    );

    const start = await axios.post(
      `${BASE_URL}/v1/apps/${APP_ID}/cloud_recording/resourceid/${resourceId}/mode/${MODE}/start`,
      {
        cname: channelName,
        uid: recordingUid,
        clientRequest: {
          token: recordingToken,
          recordingConfig: {
            channelType: 0,
            streamTypes: 0,
            audioProfile: 1,
            maxIdleTime: 60,
          },
          recordingFileConfig: {
            avFileType: ["hls", "mp4"],
          },
          storageConfig: {
            vendor: 1,
            region: 0,
            bucket: RECORDING_BUCKET,
            accessKey:
              process.env.RECORDING_ACCESS_KEY ||
              process.env.AWS_ACCESS_KEY_ID,
            secretKey:
              process.env.RECORDING_SECRET_KEY ||
              process.env.AWS_SECRET_ACCESS_KEY,
            fileNamePrefix: ["ptt_recordings", channelName],
          },
        },
      },
      { auth: { username: CUSTOMER_ID, password: CUSTOMER_SECRET } }
    );

    activeRecordings.set(channelName, {
      resourceId,
      sid: start.data.sid,
      uid: recordingUid,
    });

    console.log("✅ RECORDING STARTED:", {
      channelName,
      resourceId,
      sid: start.data.sid,
    });

    res.json({
      ok: true,
      resourceId,
      sid: start.data.sid,
    });
  } catch (err) {
    console.error("❌ START ERROR:", err.response?.data || err.message);
    res.status(500).json({
      error: "Recording start failed",
      details: err.response?.data || err.message,
    });
  }
});

// ================= STOP RECORDING =================
app.post("/stop-recording", async (req, res) => {
  try {
    const { channelName } = req.body;

    if (!channelName) {
      return res.status(400).json({ error: "Missing channelName" });
    }

    const session = activeRecordings.get(channelName);

    if (!session) {
      return res.json({
        ok: false,
        message: "No active recording session",
        fileList: [],
      });
    }

    const stop = await axios.post(
      `${BASE_URL}/v1/apps/${APP_ID}/cloud_recording/resourceid/${session.resourceId}/sid/${session.sid}/mode/${MODE}/stop`,
      {
        cname: channelName,
        uid: session.uid,
        clientRequest: {},
      },
      { auth: { username: CUSTOMER_ID, password: CUSTOMER_SECRET } }
    );

    const fileList = stop.data?.serverResponse?.fileList || [];

    console.log("✅ RECORDING STOPPED:", channelName);
    console.log("FILES FROM AGORA:", fileList);

    activeRecordings.delete(channelName);

    setTimeout(async () => {
      try {
        const mp4Files = fileList.filter((file) => {
          const fileName = typeof file === "string" ? file : file.fileName;
          return fileName && fileName.toLowerCase().endsWith(".mp4");
        });

        if (mp4Files.length === 0) {
          console.log("⚠️ No MP4 file found for conversion.");
          return;
        }

        for (const file of mp4Files) {
          const mp4Key = typeof file === "string" ? file : file.fileName;

          console.log("🎧 Starting MP3 conversion for iPhone:", mp4Key);

          const result = await convertS3Mp4ToM4a({
            bucket: RECORDING_BUCKET,
            mp4Key,
          });

          console.log("✅ MP3 created for iPhone:", result.mp3Url);
          console.log("✅ M4A also created:", result.m4aUrl);
        }
      } catch (err) {
        console.error("❌ Audio conversion failed:", err.message || err);
      }
    }, 15000);

    res.json({
      ok: true,
      fileList,
      message:
        "Recording stopped. MP3 conversion will run in the background for iPhone playback.",
    });
  } catch (err) {
    console.error("❌ STOP ERROR:", err.response?.data || err.message);

    const { channelName } = req.body || {};
    if (channelName) {
      activeRecordings.delete(channelName);
    }

    res.status(500).json({
      error: "Stop failed",
      details: err.response?.data || err.message,
    });
  }
});

// ================= PLAYBACK - FORCE MP3 FOR IPHONE =================
app.get("/play-recording", async (req, res) => {
  try {
    let { key } = req.query;

    if (!key) return res.status(400).send("Missing key");

    key = decodeURIComponent(key);

    if (key.toLowerCase().endsWith(".mp4") || key.toLowerCase().endsWith(".m4a")) {
      key = forceMp3Key(key);
    }

    console.log("▶️ PLAYBACK KEY:", key);

    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: RECORDING_BUCKET,
        Key: key,
      })
    );

    const fileSize = head.ContentLength;
    const range = req.headers.range;
    const contentType = getContentType(key);

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const data = await s3.send(
        new GetObjectCommand({
          Bucket: RECORDING_BUCKET,
          Key: key,
          Range: `bytes=${start}-${end}`,
        })
      );

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000",
      });

      return data.Body.pipe(res);
    }

    const data = await s3.send(
      new GetObjectCommand({
        Bucket: RECORDING_BUCKET,
        Key: key,
      })
    );

    res.writeHead(200, {
      "Content-Length": fileSize,
      "Accept-Ranges": "bytes",
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000",
    });

    data.Body.pipe(res);
  } catch (e) {
    console.error("PLAY ERROR:", e);
    res.status(500).send("Playback failed");
  }
});

// ================= START SERVER =================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});