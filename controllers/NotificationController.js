
const NotificationModel = require('../models/NotificationModel');

const NotificationController = {
    async markAllRead(req, res) {
        try {
            const result = await NotificationModel.markAllRead(req.session.userId);
            res.json(result);
        } catch (error) {
            console.error('Error marking all notifications as read:', error);
            res.status(500).json({ error: 'Failed to mark notifications as read' });
        }
    },

    async markReadById(req, res) {
        try {
            const result = await NotificationModel.markOneRead(req.session.userId, parseInt(req.params.id, 10));
            res.json(result);
        } catch (error) {
            console.error('Error marking notification as read:', error);
            res.status(500).json({ error: 'Failed to mark notification as read' });
        }
    },

    async clearRead(req, res) {
        try {
            const result = await NotificationModel.clearRead(req.session.userId);
            res.json(result);
        } catch (error) {
            console.error('Error marking notification as read:', error);
            res.status(500).json({ error: 'Failed to mark notification as read' });
        }
    },

    async loadMore(req, res) {
        try {
            const offset = parseInt(req.query.offset, 10) || 0;
            const result = await NotificationModel.getMoreRead(req.session.userId, offset);
            res.json(result);
        } catch (error) {
            console.error('Error marking notification as read:', error);
            res.status(500).json({ error: 'Failed to mark notification as read' });
        }
    },
};

module.exports = NotificationController;