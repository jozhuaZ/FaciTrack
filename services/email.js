/**
 * FaciTrack Email Service
 * Backend-ready with Nodemailer.
 * Currently logs emails to console (no real SMTP configured).
 * To go live: fill in SMTP_* values in .env.local and set EMAIL_ENABLED=true
 */

const nodemailer = require('nodemailer');

// ── Transport ──
// When EMAIL_ENABLED=true and SMTP credentials are set, sends real emails.
// Otherwise, logs to console only.
function createTransport() {
    if (process.env.EMAIL_ENABLED === 'true' && process.env.SMTP_HOST) {
        return nodemailer.createTransport({
            host:   process.env.SMTP_HOST,
            port:   parseInt(process.env.SMTP_PORT) || 587,
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
    }
    // Console-only transport (backend-ready placeholder)
    return null;
}

const FROM_ADDRESS = process.env.EMAIL_FROM || 'FaciTrack <noreply@cspc.edu.ph>';

/**
 * Send an email. If no real transport is configured, logs to console.
 * @param {object} opts - { to, subject, html, text }
 */
async function sendEmail({ to, subject, html, text }) {
    const transport = createTransport();
    if (transport) {
        try {
            const info = await transport.sendMail({ from: FROM_ADDRESS, to, subject, html, text });
            console.log(`[Email] Sent to ${to} | Subject: ${subject} | ID: ${info.messageId}`);
            return { success: true, messageId: info.messageId };
        } catch (err) {
            console.error(`[Email] Failed to send to ${to}:`, err.message);
            return { success: false, error: err.message };
        }
    } else {
        // Backend-ready: log the email content
        console.log(`\n[Email - CONSOLE MODE]`);
        console.log(`  To:      ${to}`);
        console.log(`  Subject: ${subject}`);
        console.log(`  Body:    ${text || '(html only)'}`);
        console.log(`[/Email]\n`);
        return { success: true, messageId: 'console-mode' };
    }
}

// ── Email Templates ──

/**
 * Booking confirmation email to student
 */
async function sendBookingConfirmation({ studentEmail, studentName, refNumber, facultyName, slot, date, topic }) {
    return sendEmail({
        to: studentEmail,
        subject: `FaciTrack – Booking Received (${refNumber})`,
        text: `Hi ${studentName},\n\nYour consultation request has been received.\n\nReference: ${refNumber}\nFaculty: ${facultyName}\nDate: ${date}\nTime: ${slot}\nTopic: ${topic}\n\nYou will be notified once the instructor responds.\n\n– FaciTrack, CSPC`,
        html: `<p>Hi <strong>${studentName}</strong>,</p>
               <p>Your consultation request has been received.</p>
               <table><tr><td><strong>Reference:</strong></td><td>${refNumber}</td></tr>
               <tr><td><strong>Faculty:</strong></td><td>${facultyName}</td></tr>
               <tr><td><strong>Date:</strong></td><td>${date}</td></tr>
               <tr><td><strong>Time:</strong></td><td>${slot}</td></tr>
               <tr><td><strong>Topic:</strong></td><td>${topic}</td></tr></table>
               <p>You will be notified once the instructor responds.</p>
               <p>– FaciTrack, CSPC</p>`
    });
}

/**
 * Appointment approved email to student
 */
async function sendApprovalNotification({ studentEmail, studentName, refNumber, facultyName, slot, date }) {
    return sendEmail({
        to: studentEmail,
        subject: `FaciTrack – Appointment Confirmed (${refNumber})`,
        text: `Hi ${studentName},\n\nYour consultation with ${facultyName} has been CONFIRMED.\n\nReference: ${refNumber}\nDate: ${date}\nTime: ${slot}\n\nPlease be on time.\n\n– FaciTrack, CSPC`,
        html: `<p>Hi <strong>${studentName}</strong>,</p>
               <p>Your consultation with <strong>${facultyName}</strong> has been <strong style="color:green">CONFIRMED</strong>.</p>
               <table><tr><td><strong>Reference:</strong></td><td>${refNumber}</td></tr>
               <tr><td><strong>Date:</strong></td><td>${date}</td></tr>
               <tr><td><strong>Time:</strong></td><td>${slot}</td></tr></table>
               <p>Please be on time.</p>
               <p>– FaciTrack, CSPC</p>`
    });
}

/**
 * Appointment declined email to student
 */
async function sendDeclineNotification({ studentEmail, studentName, refNumber, facultyName, reason }) {
    return sendEmail({
        to: studentEmail,
        subject: `FaciTrack – Appointment Declined (${refNumber})`,
        text: `Hi ${studentName},\n\nUnfortunately, your consultation request with ${facultyName} has been declined.\n\nReference: ${refNumber}\nReason: ${reason || 'No reason provided'}\n\nYou may book a new slot at your convenience.\n\n– FaciTrack, CSPC`,
        html: `<p>Hi <strong>${studentName}</strong>,</p>
               <p>Unfortunately, your consultation request with <strong>${facultyName}</strong> has been <strong style="color:red">declined</strong>.</p>
               <table><tr><td><strong>Reference:</strong></td><td>${refNumber}</td></tr>
               <tr><td><strong>Reason:</strong></td><td>${reason || 'No reason provided'}</td></tr></table>
               <p>You may book a new slot at your convenience.</p>
               <p>– FaciTrack, CSPC</p>`
    });
}

/**
 * Auto-reschedule notification email to student
 */
async function sendRescheduleNotification({ studentEmail, studentName, refNumber, facultyName, originalDate, originalSlot, newDate, newSlot }) {
    return sendEmail({
        to: studentEmail,
        subject: `FaciTrack – Appointment Rescheduled (${refNumber})`,
        text: `Hi ${studentName},\n\nYour consultation with ${facultyName} has been automatically rescheduled due to the instructor's unavailability.\n\nReference: ${refNumber}\nOriginal: ${originalDate} at ${originalSlot}\nNew Schedule: ${newDate} at ${newSlot}\n\nIf you have concerns, please contact the faculty directly.\n\n– FaciTrack, CSPC`,
        html: `<p>Hi <strong>${studentName}</strong>,</p>
               <p>Your consultation with <strong>${facultyName}</strong> has been <strong>automatically rescheduled</strong> due to the instructor's unavailability.</p>
               <table>
               <tr><td><strong>Reference:</strong></td><td>${refNumber}</td></tr>
               <tr><td><strong>Original:</strong></td><td>${originalDate} at ${originalSlot}</td></tr>
               <tr><td><strong>New Schedule:</strong></td><td><strong>${newDate} at ${newSlot}</strong></td></tr>
               </table>
               <p>If you have concerns, please contact the faculty directly.</p>
               <p>– FaciTrack, CSPC</p>`
    });
}

module.exports = {
    sendEmail,
    sendBookingConfirmation,
    sendApprovalNotification,
    sendDeclineNotification,
    sendRescheduleNotification
};
