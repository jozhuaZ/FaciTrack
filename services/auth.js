const crypto = require('crypto');
const { readData, withData } = require('./data-store');
const emailService = require('./email');

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 12); // 12 hours
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes

// In-memory OTP store (use Redis in production)
const otpStore = new Map(); // key: otpToken, value: { email, otp, expiresAt, attempts }

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, originalHash] = stored.split(':');
  const hash = hashPassword(password, salt);
  const originalBuffer = Buffer.from(originalHash, 'hex');
  const hashBuffer = Buffer.from(hash, 'hex');
  if (originalBuffer.length !== hashBuffer.length) return false;
  return crypto.timingSafeEqual(originalBuffer, hashBuffer);
}

function getDefaultUsers() {
  return [
    { name: 'System Administrator', email: 'admin@cspc.edu.ph', role: 'admin', password: 'admin123', status: 'active' },
    { name: 'Dr. Lourdes Reyes', email: 'dean@cspc.edu.ph', role: 'dean', password: 'dean123', status: 'active' },
    { name: 'Dr. Maria Santos', email: 'maria.santos@cspc.edu.ph', role: 'instructor', password: 'instructor123', status: 'active' },
    { name: 'Instructor Account', email: 'instructor@cspc.edu.ph', role: 'instructor', password: 'instructor123', status: 'active' },
    { name: 'Super Administrator', email: 'superadmin@cspc.edu.ph', role: 'superadmin', password: 'superadmin123', status: 'active' },
    { name: 'Student Account', email: 'student@my.cspc.edu.ph', role: 'student', password: 'student123', status: 'active', studentNo: '2021-00001' },
  ];
}

function ensureSeedUsers() {
  withData((db) => {
    const next = { ...db, users: Array.isArray(db.users) ? db.users.slice() : [], sessions: Array.isArray(db.sessions) ? db.sessions.slice() : [] };
    const byEmail = new Map(next.users.map((u) => [String(u.email || '').toLowerCase(), u]));
    let idCounter = next.users.reduce((max, u) => Math.max(max, Number(u.id) || 0), 0) + 1;

    for (const user of getDefaultUsers()) {
      const email = user.email.toLowerCase();
      if (byEmail.has(email)) continue;
      const newUser = {
        id: idCounter++,
        name: user.name,
        email,
        role: user.role,
        status: user.status,
        passwordHash: createPasswordHash(user.password),
        createdAt: new Date().toISOString(),
      };
      // Add studentNo if provided
      if (user.studentNo) newUser.studentNo = user.studentNo;
      next.users.push(newUser);
    }
    return next;
  });
}

function cleanupExpiredSessions() {
  withData((db) => {
    const now = Date.now();
    return {
      ...db,
      sessions: (db.sessions || []).filter((s) => Number(s.expiresAt) > now),
    };
  });
}

function authenticateUser(email, password) {
  const db = readData();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = (db.users || []).find((u) => String(u.email || '').toLowerCase() === normalizedEmail);
  if (!user || user.status !== 'active') return null;
  if (!verifyPassword(String(password || ''), user.passwordHash)) return null;
  return user;
}

function createSession(user, reqMeta = {}) {
  cleanupExpiredSessions();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session = {
    token,
    userId: user.id,
    role: user.role,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    ip: reqMeta.ip || '',
    userAgent: reqMeta.userAgent || '',
  };
  withData((db) => ({
    ...db,
    sessions: [...(db.sessions || []), session],
  }));
  return session;
}

function getSessionByToken(token) {
  if (!token) return null;
  cleanupExpiredSessions();
  const db = readData();
  const session = (db.sessions || []).find((s) => s.token === token);
  if (!session) return null;
  const user = (db.users || []).find((u) => Number(u.id) === Number(session.userId));
  if (!user || user.status !== 'active') return null;
  return { session, user };
}

function revokeSession(token) {
  if (!token) return;
  withData((db) => ({
    ...db,
    sessions: (db.sessions || []).filter((s) => s.token !== token),
  }));
}

function getRoleRedirect(role) {
  const map = {
    admin: '/admin/dashboard',
    dean: '/dean/dashboard',
    instructor: '/instructor/dashboard',
    superadmin: '/superadmin/dashboard',
    student: '/student/dashboard',
  };
  return map[role] || '/';
}

// ── OTP Functions ──

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
}

function generateOTPToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createOTP(email) {
  const otp = generateOTP();
  const otpToken = generateOTPToken();
  const expiresAt = Date.now() + OTP_TTL_MS;

  otpStore.set(otpToken, {
    email: email.toLowerCase(),
    otp,
    expiresAt,
    attempts: 0,
  });

  // Send OTP via email
  emailService.sendEmail({
    to: email,
    subject: 'FaciTrack - Your Verification Code',
    text: `Your verification code is: ${otp}\n\nThis code will expire in 5 minutes.\n\n– FaciTrack, CSPC`,
    html: `<p>Your verification code is:</p>
           <h2 style="font-family: monospace; font-size: 2rem; letter-spacing: 0.5rem; color: #0a3d62;">${otp}</h2>
           <p>This code will expire in <strong>5 minutes</strong>.</p>
           <p>– FaciTrack, CSPC</p>`,
  });

  console.log(`[OTP] Generated for ${email}: ${otp} (Token: ${otpToken})`);

  return { otpToken, expiresAt };
}

function verifyOTP(otpToken, enteredOTP) {
  const record = otpStore.get(otpToken);

  if (!record) {
    return { success: false, error: 'Invalid or expired verification code.' };
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(otpToken);
    return { success: false, error: 'Verification code has expired.' };
  }

  record.attempts += 1;

  if (record.attempts > 3) {
    otpStore.delete(otpToken);
    return { success: false, error: 'Too many failed attempts. Please request a new code.' };
  }

  if (record.otp !== enteredOTP) {
    return { success: false, error: 'Incorrect verification code.' };
  }

  // Success - remove OTP
  const email = record.email;
  otpStore.delete(otpToken);

  return { success: true, email };
}

function cleanupExpiredOTPs() {
  const now = Date.now();
  for (const [token, record] of otpStore.entries()) {
    if (record.expiresAt < now) {
      otpStore.delete(token);
    }
  }
}

// Cleanup expired OTPs every minute
setInterval(cleanupExpiredOTPs, 60 * 1000);

// ── Google OAuth Functions ──

function createGoogleAuthURL() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';
  const scope = 'email profile';
  const state = crypto.randomBytes(32).toString('hex');

  // Store state for CSRF protection (in production, use session or Redis)
  const stateStore = new Map();
  stateStore.set(state, { createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state,
    access_type: 'offline',
    prompt: 'select_account',
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function verifyGoogleToken(code) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

  try {
    // Exchange code for token
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      return { success: false, error: 'Failed to obtain access token.' };
    }

    // Get user info
    const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const userData = await userResponse.json();

    if (!userData.email) {
      return { success: false, error: 'Failed to get user email.' };
    }

    // Validate CSPC student email
    if (!userData.email.endsWith('@my.cspc.edu.ph')) {
      return { success: false, error: 'Please use your CSPC student email (@my.cspc.edu.ph).' };
    }

    return { success: true, email: userData.email, name: userData.name, picture: userData.picture };
  } catch (error) {
    console.error('[Google OAuth] Error:', error);
    return { success: false, error: 'Authentication failed. Please try again.' };
  }
}

module.exports = {
  ensureSeedUsers,
  authenticateUser,
  createSession,
  getSessionByToken,
  revokeSession,
  getRoleRedirect,
  createOTP,
  verifyOTP,
  createGoogleAuthURL,
  verifyGoogleToken,
};
