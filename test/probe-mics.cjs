// 探测每个麦克风设备，找出真正有数据的那一个
const path = require('node:path');
const PLUGIN = process.env.VOICE_PLUGIN_DIR || path.resolve(__dirname, '..', '..', 'voice-plugin');
const { PvRecorder } = require(path.join(PLUGIN, 'node_modules', '@picovoice', 'pvrecorder-node'));

const FRAME = 1600;

(async () => {
  const devices = PvRecorder.getAvailableDevices() || [];
  console.log('  设备数: ' + devices.length);
  devices.forEach((d, i) => console.log(`    [${i}] ${d}`));

  for (let i = 0; i < devices.length; i += 1) {
    let rec;
    try {
      rec = new PvRecorder(FRAME, i, 200);
      rec.start();
      let peak = 0;
      let frames = 0;
      for (let k = 0; k < 6; k += 1) {
        const f = await rec.read();
        frames += 1;
        for (let j = 0; j < f.length; j += 1) peak = Math.max(peak, Math.abs(f[j]));
      }
      console.log(`    [${i}] frames=${frames} peak=${peak} ${peak > 0 ? '← 有数据 ✅' : '(全 0)'}`);
    } catch (e) {
      console.log(`    [${i}] 打不开: ${e.message}`);
    } finally {
      try { rec.stop(); rec.release(); } catch { /* ignore */ }
    }
  }
})();
