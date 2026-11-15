// 在独立子进程里探测"哪个麦克风真的有数据"，只打印 INDEX=<n>。
// 为什么要子进程：在同一个进程里先探测再打开同一个设备，PortAudio 会返回全 0。
const path = require('node:path');
const PLUGIN = process.env.VOICE_PLUGIN_DIR || path.resolve(__dirname, '..', '..', 'voice-plugin');
const { PvRecorder } = require(path.join(PLUGIN, 'node_modules', '@picovoice', 'pvrecorder-node'));

const FRAME = 1600;

(async () => {
  const devices = PvRecorder.getAvailableDevices() || [];
  for (let i = 0; i < devices.length; i += 1) {
    let rec;
    try {
      rec = new PvRecorder(FRAME, i, 100);
      rec.start();
      let peak = 0;
      for (let k = 0; k < 6; k += 1) {
        const f = await rec.read();
        for (let j = 0; j < f.length; j += 1) peak = Math.max(peak, Math.abs(f[j]));
      }
      process.stdout.write(`DEVICE ${i} ${devices[i]} peak=${peak}\n`);
      if (peak > 0) {
        process.stdout.write(`INDEX=${i}\n`);
        break;
      }
    } catch (e) {
      process.stdout.write(`DEVICE ${i} failed: ${e.message}\n`);
    } finally {
      try { rec.stop(); } catch { /* ignore */ }
      try { rec.release(); } catch { /* ignore */ }
    }
  }
})();
