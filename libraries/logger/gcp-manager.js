const bunyan = require('bunyan')

/**
 * When we copy log entry fields, omit some bunyan core fields that are not
 * interesting, that have a special meaning in GCP, or that we will process
 * separately.
 */
const ENTRY_FIELDS_TO_OMIT = [
  'level',
  'name',
  'hostname',
  'v',
  'pid',
  'msg',
  'err',
  'req',
  'res'
]

/**
 * Convert a bunyan log entry to a format that GCP understands
 */
function convertLogEntry(entry) {
  const gcpEntry = omit(entry, ENTRY_FIELDS_TO_OMIT)

  // Error information. In GCP, the stack trace goes in the message property.
  // This enables the error reporting feature.
  if (entry.err) {
    if (entry.err.info) {
      Object.assign(gcpEntry, entry.err.info)
    }
    if (entry.err.code) {
      gcpEntry.code = entry.err.code
    }
    if (entry.err.signal) {
      gcpEntry.signal = entry.err.signal
    }
    if (entry.err.stack) {
      gcpEntry.message = entry.err.stack
    }
    if (entry.name) {
      gcpEntry.serviceContext = { service: entry.name }
    }
  } else {
    gcpEntry.message = entry.msg
  }

  // Severity
  if (entry.level) {
    gcpEntry.severity = bunyan.nameFromLevel[entry.level]
  }

  // HTTP request information
  if (entry.req || entry.res || entry.responseTimeMs) {
    const httpRequest = {}
    if (entry.req) {
      const req = entry.req
      httpRequest.requestMethod = req.method
      httpRequest.requestUrl = req.url
      httpRequest.remoteIp = req.remoteAddress
      if (req.headers) {
        if (req.headers['content-length']) {
          httpRequest.requestSize = parseInt(req.headers['content-length'], 10)
        }
        httpRequest.userAgent = req.headers['user-agent']
        httpRequest.referer = req.headers.referer
      }
    }

    if (entry.res) {
      const res = entry.res
      httpRequest.status = res.statusCode
      if (res.headers && res.headers['content-length']) {
        if (res.headers['content-length']) {
          httpRequest.responseSize = parseInt(res.headers['content-length'], 10)
        }
      }
    }

    if (entry.responseTimeMs) {
      const responseTimeSec = entry.responseTimeMs / 1000
      httpRequest.latency = `${responseTimeSec}s`
    }
    gcpEntry.httpRequest = httpRequest
  }

  // Labels are indexed in GCP. We copy the project, doc and user ids to labels to enable fast filtering
  const projectId = gcpEntry.projectId || gcpEntry.project_id
  const userId = gcpEntry.userId || gcpEntry.user_id
  const docId = gcpEntry.docId || gcpEntry.doc_id
  if (projectId || userId || docId) {
    const labels = {}
    if (projectId) {
      labels.projectId = projectId
    }
    if (userId) {
      labels.userId = userId
    }
    if (docId) {
      labels.docId = docId
    }
    gcpEntry['logging.googleapis.com/labels'] = labels
  }

  return gcpEntry
}

function omit(obj, excludedFields) {
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => !excludedFields.includes(key))
  )
}

module.exports = { convertLogEntry }
