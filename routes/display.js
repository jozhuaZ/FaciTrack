const express = require('express');
const router = express.Router();

// Reuse the same faculty data from dean — no auth required
const faculty = [
    { name: 'Dr. Maria Santos', bleStatus: 'in-room' },
    { name: 'Prof. Jose Dela Cruz', bleStatus: 'out-of-room' },
    { name: 'Dr. Ana Villanueva', bleStatus: 'in-room' },
    { name: 'Prof. Carlos Bautista', bleStatus: 'out-of-room' },
    { name: 'Dr. Ramon Aquino', bleStatus: 'in-room' },
    { name: 'Prof. Liza Navarro', bleStatus: 'in-room' },
    { name: 'Dr. Eduardo Flores', bleStatus: 'in-room' },
    { name: 'Prof. Grace Mendoza', bleStatus: 'out-of-room' },
    { name: 'Dr. Benjamin Reyes', bleStatus: 'in-room' },
    { name: 'Prof. Maricel Castro', bleStatus: 'out-of-room' }
];

router.get('/display', (req, res) => {
    res.render('pages/public-display', { faculty });
});

module.exports = router;
