// @name llmRetry
// @desc LLM/外部服务限流与网络抖动的指数退避自动重试（3^n 秒序列：3s→9s→27s→81s）
// 零依赖；供内层 LLM 调用与外层 opencode 会话复用

// 可重试判定：限流（429/402/503 或响应体特征词）与传输网络抖动
const RETRY_STATUS = new Set([429, 402, 503]);
function isRetryableStatus(status) {
  return RETRY_STATUS.has(status);
}
function isRateLimitText(t) {
  return /rate.?limit|too many requests|quota|insufficient|overload|capacity|throttl|限流|频率过高|请求过多/i.test(String(t || ''));
}
// 网络层异常 code（fetch throw 时 e.code）：连接被重置/拒绝、超时、DNS 抖动、管道断裂
const NET_CODES = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENOTFOUND|UND_ERR|ECONNABORTED)$/;

class RetryableError extends Error {
  constructor(msg) { super(msg); this.name = 'RetryableError'; this.retryable = true; }
}

// 指数退避执行器：fn 抛 RetryableError / 网络 code 错误时按 base*3^n 退避重试
// - baseMs 默认 3000（3s/9s/27s/81s），DUAL_AGENT_RETRY_BASE_MS 可覆盖（测试注入短基数）
// - maxRetries 默认 4（共 1+4=5 次尝试），全部耗尽抛最后一个错误
// - 每次退避经 onEvent({type:'info'}) 通知（前端可见"X 秒后自动重试（第 n/4 次）"）
async function withRetry(fn, opts = {}) {
  const { onEvent, label = 'LLM', maxRetries = 4 } = opts;
  const baseMs = opts.baseMs !== undefined
    ? opts.baseMs
    : Number(process.env.DUAL_AGENT_RETRY_BASE_MS) || 3000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = (e && e.retryable) || (e && e.code && NET_CODES.test(e.code));
      if (!retryable || attempt >= maxRetries) throw e;
      const wait = baseMs * Math.pow(3, attempt); // 3^0..3^(maxRetries-1)：3s→9s→27s→81s
      const nth = attempt + 1;
      const reason = String((e && e.message) || e).slice(0, 140);
      if (onEvent) {
        onEvent({
          type: 'info',
          text: `${label}请求被限流/中断（${reason}），${Math.round(wait / 1000)} 秒后自动重试（第 ${nth}/${maxRetries} 次）`
        });
      }
      if (process.env.DUAL_AGENT_DEBUG_RETRY === '1') {
        try {
          const fs = require('fs');
          const path = require('path');
          fs.appendFileSync(
            path.join(process.env.DUAL_AGENT_DATA || path.join(__dirname, '..', '.data'), 'retry-debug.log'),
            `${new Date().toISOString()} ${label} attempt=${nth}/${maxRetries} wait=${wait}ms err=${reason}\n`
          );
        } catch { /* ignore */ }
      }
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

module.exports = { withRetry, RetryableError, isRetryableStatus, isRateLimitText, NET_CODES };
