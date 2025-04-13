import ffmpeg from "fluent-ffmpeg";
import { Readable, Writable } from "stream";

/**
 * Converts audio from PCM to PCMU/8000.
 * @param {Buffer} inputBuffer - The audio buffer in PCM format.
 * @returns {Promise<Buffer>} - A promise that resolves with the converted audio buffer in PCMU/8000 format.
 */
export function convertToPcmu(inputBuffer) {
  return new Promise((resolve, reject) => {
    const inputStream = new Readable();
    inputStream.push(inputBuffer);
    inputStream.push(null);

    const outputBuffers = [];
    const outputStream = new Writable({
      write(chunk, encoding, callback) {
        outputBuffers.push(chunk);
        callback();
      },
    });

    ffmpeg(inputStream)
      .inputFormat("s16le") // Assuming PCM format
      .audioCodec("pcm_mulaw")
      .audioFrequency(8000)
      .format("mulaw")
      .on("error", (err) => {
        console.error("Error converting audio:", err);
        reject(err);
      })
      .on("end", () => {
        resolve(Buffer.concat(outputBuffers));
      })
      .pipe(outputStream, { end: true });
  });
}
