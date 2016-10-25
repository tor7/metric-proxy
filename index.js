"use strict"

// Dependencies
// ===

const CookieParser = require("cookie-parser")

// web server
const Express = require("express")

// better than debugger
const Pry = require("pryjs")

// HTTP requests
const Request = require("request")

// Logging
const Winston = require("winston")


// Config
// ===

const MIXPANEL_API_HOST = process.env.MIXPANEL_API_HOST || "https://api.mixpanel.com"
// e.g. token1234a,token5678b
const MIXPANEL_TOKEN_WHITELIST = process.env.MIXPANEL_TOKEN_WHITELIST.split(",")
const NODE_ENV = process.env.NODE_ENV || "development"
const LOG_LEVEL = NODE_ENV === "production"
  ? "info"
  : "debug"
const COOKIE_PERSISTED_PARAMS = process.env.COOKIE_PERSISTED_PARAMS
  ? process.env.COOKIE_PERSISTED_PARAMS.split(",")
  : ["campaign", "creative", "placement", "referer", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]
const PERSISTED_COOKIE_NAME = "metricProxy"
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN
const COOKIE_SECURE_ATTRIBUTE = (NODE_ENV === "production")
const COOKIE_SIGNING_SECRET = NODE_ENV === "production"
  ? process.env.COOKIE_SIGNING_SECRET
  : null
const COOKIE_TTL = 14 * 24 * 60 * 60 * 1000
const PORT = process.env.PORT || 4000
const USER_AGENT = `metric-proxy/${process.env.npm_package_version} (brave.com)`


// Lib
// ===

var logger = new (Winston.Logger)({
  level: LOG_LEVEL,
  transports: [
    new (Winston.transports.Console)()
  ]
})

function isValidMixpanelToken(token) {
  if (!token) {
    return false
  }
  return MIXPANEL_TOKEN_WHITELIST.includes(token)
}

// Log additional things in development environments.
function debugLogger(request, response, next) {
  const dataString = Buffer.from(request.query.data, "base64").toString("utf-8")
  const data = JSON.parse(dataString)
  logger.debug("-> Headers:", request.headers)
  if (request.cookies) {
    for (let cookieName in request.cookies) {
      logger.debug(`-> Cookie: ${cookieName}:`, request.cookies[cookieName])
    }
  }
  logger.debug("-> Query:", request.query)
  logger.debug("-> Data:", data)
  next()
}

// Log Request responses from Mixpanel
function logRequestResponse(response) {
  logger.debug("<<", response.statusCode)
  logger.debug("<<", response.headers)
}

// Takes an example URL with tracking parameters and persists them to cookies.
// Alternative to the mixpanel library, which persists things like utm_* as
// Super Properties.
// Useful where JS is unavailable like tracking pixels or click redirects.
function paramCookiePersister(request, response, next) {
  let cookieParams = {}
  COOKIE_PERSISTED_PARAMS.forEach((key) => {
    if (!request.query[key]) {
      return
    }
    cookieParams[key] = request.query[key]
  })
  if (Object.keys(cookieParams).length === 0) {
    next()
    return
  }
  let options = {
    httpOnly: true,
    expires: new Date(Date.now() + COOKIE_TTL),
    secure: COOKIE_SECURE_ATTRIBUTE,
    signed: !!COOKIE_SIGNING_SECRET
  }
  if (COOKIE_DOMAIN) {
    options["domain"] = COOKIE_DOMAIN
  }
  logger.debug(`<< Cookie: ${PERSISTED_COOKIE_NAME}:`, cookieParams)
  response.cookie(PERSISTED_COOKIE_NAME, cookieParams, options)
  next()
}


// App fn
// ===

// https://mixpanel.com/help/reference/http
function mixpanelTrack(request, response) {
  try {
    const dataString = Buffer.from(request.query.data, "base64").toString("utf-8")
    const data = JSON.parse(dataString)
    logger.info(`-> ${request.method} /track`)
    if (!isValidMixpanelTrackData(data)) {
      throw "Invalid data"
    }

    // /track supports other params but not sure if we want them
    let queryString = {}
    const queryStringParams = ["data", "img", "verbose"]
    queryStringParams.forEach((value) => {
      if (!request.query[value]) {
        return
      }
      queryString[value] = request.query[value]
    })
    const mixpanelRequestOptions = {
      headers: {
        // 'Cookie': request.headers.cookie,
        'User-Agent': USER_AGENT
      },
      qs: queryString
    }

    logger.debug(`API > ${request.method} ${MIXPANEL_API_HOST}/track`, mixpanelRequestOptions)
    Request(`${MIXPANEL_API_HOST}/track`, mixpanelRequestOptions).
      on("error", (error) => {
        logger.error(error)
        response.status(502).send("0")
      }).
      on("response", function(response) {
        if (LOG_LEVEL === "debug") {
          logRequestResponse(response)
        }
      }).
      pipe(response)

  } catch (_e) {
    if (_e.stack) {
      logger.error(_e.stack.split("\n").slice(0, 4).join(";"))
    } else {
      logger.error(_e)
    }
    response.send("0")
  }
}

function isValidMixpanelTrackData(data) {
  return (data.event && data.properties && isValidMixpanelToken(data.properties.token))
}


// App
// ===


// Express setup
// ---
var express = Express()
express.disable("x-powered-by")
if (COOKIE_SIGNING_SECRET) {
  express.use(CookieParser(COOKIE_SIGNING_SECRET))
} else {
  express.use(CookieParser())
}
express.use(paramCookiePersister)
if (LOG_LEVEL === "debug") {
  express.use(debugLogger)
}


// Routes
// ---
express.get("/", (request, response) => {
  response.send("hello friend")
})

express.get("/track", mixpanelTrack)
express.post("/track", mixpanelTrack)

express.listen(PORT)

logger.info(`MIXPANEL_API_HOST: ${MIXPANEL_API_HOST}`)
logger.info(`NODE_ENV: ${NODE_ENV}`)
logger.info(`metric-proxy up on localhost:${PORT}`)
