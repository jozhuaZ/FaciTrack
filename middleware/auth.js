const { getSessionByToken, revokeSession } = require('../services/auth');

const SESSION_COOKIE_NAME = 'facitrack_sid';

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const items = raw.split(';').map((v) => v.trim()).filter(Boolean);
  const cookies = {};
  for (const item of items) {
    const idx = item.indexOf('=');
    if (idx === -1) continue;
    const key = item.slice(0, idx).trim();
    const value = decodeURIComponent(item.slice(idx + 1).trim());
    cookies[key] = value;
  }
  return cookies;
}

function setSessionCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 12),
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

function authContext(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  req.authToken = token || null;
  req.currentUser = null;
  if (token) {
    const payload = getSessionByToken(token);
    if (payload) {
      req.currentUser = payload.user;
    } else {
      revokeSession(token);
      clearSessionCookie(res);
    }
  }
  res.locals.currentUser = req.currentUser;
  next();
}

const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
};

const requireRole = (...roles) => (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    if (!roles.includes(req.session.role)) {
        return res.status(403).render('pages/403', { title: 'Access Denied' });
    }
    next();
};

module.exports = {
  SESSION_COOKIE_NAME,
  authContext,
  requireAuth,
  requireRole,
  setSessionCookie,
  clearSessionCookie,
};
