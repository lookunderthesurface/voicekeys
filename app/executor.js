// 执行器：持有一个常驻的 PowerShell worker（原语执行），不每命令重启。
const path = require('node:path');
const core = require(path.resolve(__dirname, '..', 'src', 'core.js'));

class Executor {
  constructor() {
    this.worker = null;
    this.busy = false;
  }

  async ensure() {
    if (this.worker) return this.worker;
    this.worker = new core.Worker();
    await this.worker.call({ op: 'ping' });   // 预热
    return this.worker;
  }

  async run(plan) {
    const check = core.validatePlan(plan);
    if (!check.ok) return { ok: false, errors: check.errors };
    const worker = await this.ensure();
    const out = await core.execute(check.plan, { worker });
    return { ok: true, plan: check.plan, execution: out };
  }

  stop() {
    if (this.worker) {
      try { this.worker.stop(); } catch { /* ignore */ }
      this.worker = null;
    }
  }
}

module.exports = { Executor };
