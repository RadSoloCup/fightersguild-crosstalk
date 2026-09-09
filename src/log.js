const levels = { error: 0, warn: 1, info: 2, debug: 3 }
const threshold = levels[process.env.LOG_LEVEL] ?? levels.info

function emit(level, scope, args) {
  if (levels[level] > threshold) return
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}]`
  ;(level === 'error' ? console.error : console.log)(line, ...args)
}

export function logger(scope) {
  return {
    error: (...a) => emit('error', scope, a),
    warn: (...a) => emit('warn', scope, a),
    info: (...a) => emit('info', scope, a),
    debug: (...a) => emit('debug', scope, a),
  }
}
