'use strict'

const Redis = require('ioredis')
const crypto = require('crypto')
const program = require('commander')

program
  .version('0.0.8')
  .option('-t, --type <val>', 'queue type [sidekiq | bull | resque]')
  .option('-l, --list <val>', 'source redis list (i.e: global_jobs)')
  .option('-r, --redis <val>', 'redis url (i.e: redis://127.0.0.1:6379)')
  .option('-f, --freq <n>', 'poll frequency (in milliseconds) - default: 10', parseInt)
  .option('-b, --batch <n>', 'max number of jobs created per batch - default: 1000', parseInt)
  .option('--q_prefix <val>', 'redis queue prefix (i.e: "resque" or "bull")')
  .option('--def_queue <val>', 'default dest queue - default: default')
  .option('--def_worker <val>', 'default Job Queue worker - default: BaseJob')
  .option('--def_attempts <val>', 'default Bull Job attempts - default: 1', parseInt)
  .option('--q_lifo', 'Bull LIFO mode')
  .option('--debug', 'debug')
  .parse(process.argv)

if (!program.freq) program.freq = 10
if (!program.batch) program.batch = 1000
if (!program.def_queue) program.def_queue = 'default'
if (!program.def_worker) program.def_worker = 'BaseJob'
if (!program.def_attempts) program.def_attempts = 1
if (!program.q_prefix) program.q_prefix = ''

var showHelp = false

var ptype = program.type

if (!ptype || !program.list || !program.redis) {
  showHelp = true
}

if (['sidekiq', 'bull', 'resque'].indexOf(ptype) === -1) {
  showHelp = true
}

if (showHelp) {
  program.help()
  process.exit()
}

switch (ptype) {
  case 'resque':
    if (!program.q_prefix) program.q_prefix = 'resque:'
    break
}

console.log('caron(' + program.redis + '/' + program.list + '/' + program.type + ')')

var redis = Redis.createClient(program.redis, {
  dropBufferSupport: true
})

var scripts = {
  prefix: [
    'local cnt = 0',
    'local err = 0',
    'while ((redis.call("LLEN", "' + program.list + '") ~= 0) and (cnt < ' + program.batch + ')) do',
    '  local msg = redis.call("RPOP", "' + program.list + '")',
    '  if not msg then break end',
    '  local cmsg = cjson.decode(msg)',
    '  if not cmsg or type(cmsg) ~= "table" then',
    '    err = -2',
    '    break',
    '  end',
    '  if not cmsg["$queue"] then cmsg["$queue"] = "' + program.def_queue + '" end',
    '  local jqueue = cmsg["$queue"]',
    '  cmsg["$queue"] = nil'
  ].join("\n"),
  suffix: [
    '  cnt = cnt + 1',
    'end',
    'return {err, cnt}'
  ].join("\n"),
  ruby_common_1: [
    'if not cmsg["$class"] then cmsg["$class"] = "' + program.def_worker + '" end',
    'local payload = { queue = jqueue, jid = ARGV[1], class = cmsg["$class"] }',
    'cmsg["$class"] = nil',
    'payload["args"] = { cmsg }',
    'redis.call("SADD", "' + program.q_prefix + 'queues", jqueue)'
  ].join("\n")
}

scripts.bull = {
  lua: [
    'local pushCmd = "' + (program.q_lifo ? 'R' : 'L') + 'PUSH"',
    'local jobId = redis.call("INCR", "bull:" .. jqueue .. ":id")',
    'local jattempts = cmsg["$attempts"]',
    'local jdelay = cmsg["$delay"]',
    'cmsg["$attempts"] = nil',
    'cmsg["$delay"] = nil',
    'if (type(jattempts) ~= "number") or (jattempts <= 0) then jattempts = ' + program.def_attempts + ' end',
    'if (type(jdelay) ~= "number") or (jdelay < 0) then jdelay = 0 end',
    'redis.call("HMSET", "bull:" .. jqueue .. ":" .. jobId, "data", msg, "opts", "{}", "progress", 0, "delay", jdelay, "timestamp", ARGV[1], "attempts", jattempts, "attemptsMade", 0, "stacktrace", "[]", "returnvalue", "null")',
    'if jdelay > 0 then',
    '  local timestamp = (tonumber(ARGV[1]) + jdelay) * 0x1000 + bit.band(jobId, 0xfff)',
    '  redis.call("ZADD", "bull:" .. jqueue .. ":delayed", timestamp, jobId)',
    '  redis.call("PUBLISH", "bull:" .. jqueue .. ":delayed", (timestamp / 0x1000))',
    'else',
    '  if redis.call("EXISTS", "bull:" .. jqueue .. ":meta-paused") ~= 1 then',
    '    redis.call(pushCmd, "bull:" .. jqueue .. ":wait", jobId)',
    '  else',
    '    redis.call(pushCmd, "bull:" .. jqueue .. ":paused", jobId)',
    '  end',
    '  redis.call("PUBLISH", "bull:" .. jqueue .. ":jobs", jobId)',
    'end',
  ].join("\n")
}

scripts.sidekiq = {
  lua: scripts.ruby_common_1 + "\n" + [
    'redis.call("LPUSH", "' + program.q_prefix + 'queue:" .. jqueue, cjson.encode(payload))',
  ].join("\n")
}
  
scripts.resque = {
  lua: scripts.ruby_common_1 + "\n" + [
    'redis.call("RPUSH", "' + program.q_prefix + 'queue:" .. jqueue, cjson.encode(payload))',
  ].join("\n")
}

var script = [scripts.prefix, scripts[ptype].lua, scripts.suffix].join("\n")

redis.defineCommand('qwork', {
  lua: script,
  numberOfKeys: 0
})

var elapsed_time = (start) => {
  return process.hrtime(start)
}

var work = () => {
  var args = []
  var ts_start = null
  
  if (program.debug) {
    ts_start = process.hrtime()
  }
  
  switch (ptype) {
    case 'bull':
      args.push(Date.now())
      break
    case 'sidekiq':
      args.push(crypto.randomBytes(12).toString('hex'))
      break
  }
  
  args.push(
    (err, res) => {
      if (err) {
        console.error(err)
        process.exit()
        return
      }

      if (program.debug) {
        let elapsed = elapsed_time(ts_start)
        console.log(res[1] + ' jobs processed in ' + elapsed[0] + 's,' + Math.round(elapsed[1] / 1000) + 'µs')
      }

      setTimeout(() => {
        work()
      }, program.freq)
    }
  )

  redis.qwork.apply(
    redis, args
  )
}

work()
