const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const UserModel = require('../models/UserModel');
const fileStore = require('../services/file-store');

/**
 * Profile photos.
 *
 * Files are handed out by serve() below rather than sitting under public/, so
 * nothing is web-reachable by accident — the same arrangement make-up
 * documents use. The column stores the finished web path ("/avatars/<uuid>
 * .jpg"), so every existing <img src="<%= ...profilePhoto %>"> keeps working
 * untouched.
 *
 * Where the bytes actually land is services/file-store.js: on disk where there
 * is one, in the database on a host where there is not.
 */

const WEB_PREFIX = '/avatars/';

/** The web path the column stores, turned into the key the store uses. */
const keyFor = (name) => `avatars/${name}`;

// Rendered between 40px and 96px across the app, so 256 covers retina without
// keeping a multi-megabyte camera original to fill a thumbnail.
const AVATAR_SIZE = 256;

// The shape of a name we generated ourselves, and the only shape serve() will
// open — a request can therefore never name a path we did not write.
const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

/** Remove a stored avatar, ignoring anything that is not one of ours. */
async function deleteStored(webPath) {
    if (!webPath || !webPath.startsWith(WEB_PREFIX)) return;
    const name = path.basename(webPath);
    if (!STORED_NAME.test(name)) return;
    // Best effort: a failed delete costs storage, not correctness.
    await fileStore.remove(keyFor(name)).catch(() => {});
}

const ProfileController = {

    async uploadAvatar(req, res) {
        if (!req.file) {
            return res.status(400).json({ status: 'error', message: 'No image was uploaded.' });
        }

        let filename = null;
        try {
            // Decoding IS the validation — a renamed .exe never gets this far, so
            // the check does not rest on a client-supplied MIME type. Re-encoding
            // also drops EXIF, which on phone photos carries GPS coordinates.
            const processed = await sharp(req.file.buffer)
                .rotate()   // apply the EXIF orientation before that tag is discarded
                .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
                .jpeg({ quality: 82 })
                .toBuffer();

            filename = `${crypto.randomUUID()}.jpg`;
            await fileStore.put({
                key: keyFor(filename),
                buffer: processed,
                mimeType: 'image/jpeg',
                kind: 'avatar',
            });

            const webPath = WEB_PREFIX + filename;
            const result = await UserModel.updateProfilePicture(req.session.userId, webPath);

            if (!result) {
                // The session outlived the account — do not leave the file behind.
                await deleteStored(webPath);
                return res.status(404).json({ status: 'error', message: 'Account not found.' });
            }

            // Read on every sidebar render. Without this the new photo would show
            // until the next page load and then appear to revert.
            req.session.profilePhoto = webPath;

            await deleteStored(result.previous);

            res.json({ status: 'ok', url: webPath });
        } catch (err) {
            if (filename) await deleteStored(WEB_PREFIX + filename);

            // sharp refuses anything it cannot decode; that is a bad upload
            // rather than a server fault, so answer 400 and say what happened.
            if (/unsupported image|input buffer|input file/i.test(err.message || '')) {
                return res.status(400).json({
                    status: 'error',
                    message: 'That file is not a readable image.',
                });
            }
            console.error('[ProfileController.uploadAvatar]', err);
            // The code (ER_NO_SUCH_TABLE, ECONNREFUSED…) names the failure
            // without exposing anything sensitive, so a failure on a host whose
            // logs are a step away can still be diagnosed from the toast.
            res.status(500).json({
                status: 'error',
                message: 'Could not save the photo' + (err.code ? ` (${err.code}).` : '.'),
            });
        }
    },

    /**
     * Drop the photo and fall back to initials.
     *
     * This is a replacement without the replacement, so it reuses the same
     * model call and the same cleanup. Removing when there is nothing to remove
     * is not an error — the caller wanted no photo, and there is no photo.
     */
    async removeAvatar(req, res) {
        try {
            const result = await UserModel.updateProfilePicture(req.session.userId, null);
            if (!result) {
                return res.status(404).json({ status: 'error', message: 'Account not found.' });
            }

            req.session.profilePhoto = null;
            await deleteStored(result.previous);

            res.json({ status: 'ok', url: null });
        } catch (err) {
            console.error('[ProfileController.removeAvatar]', err);
            res.status(500).json({ status: 'error', message: 'Could not remove the photo.' });
        }
    },

    /**
     * Any signed-in user may view any avatar: students see faculty photos in the
     * directory, deans across their department, admins everywhere. The filename
     * is a UUID we generated, so it is not guessable from a user id.
     */
    async serve(req, res) {
        const name = req.params.file;
        if (!STORED_NAME.test(name)) return res.status(404).end();

        try {
            const file = await fileStore.get(keyFor(name));
            if (!file) return res.status(404).end();

            // A replacement upload gets a fresh UUID and therefore a fresh URL,
            // so a cached copy can never become stale.
            res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
            res.setHeader('Content-Type', file.mimeType || 'image/jpeg');
            res.setHeader('Content-Length', file.buffer.length);
            res.end(file.buffer);
        } catch (err) {
            console.error('[ProfileController.serve]', err);
            if (!res.headersSent) res.status(404).end();
        }
    },
};

module.exports = ProfileController;
