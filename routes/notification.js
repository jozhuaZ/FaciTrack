const express = require('express');
const router = express.Router();
const NotificationController = require('../controllers/NotificationController');

router.post('/mark-all-read', NotificationController.markAllRead);

router.post('/:id/mark-read', NotificationController.markReadById);

router.delete('/read', NotificationController.clearRead);

router.get('/more', NotificationController.loadMore);


module.exports = router;
