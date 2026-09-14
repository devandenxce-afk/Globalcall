const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ===== MATCHMAKING =====
let waitingUser = null;

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('start-match', () => {
    if (waitingUser && waitingUser !== socket.id) {
      const partnerId = waitingUser;
      waitingUser = null;
      socket.join(partnerId);
      io.to(partnerId).emit('match-found', { partnerId: socket.id, initiator: true });
      socket.emit('match-found', { partnerId, initiator: false });
    } else {
      waitingUser = socket.id;
      socket.emit('waiting');
    }
  });

  socket.on('offer', ({ to, offer }) => io.to(to).emit('offer', { from: socket.id, offer }));
  socket.on('answer', ({ to, answer }) => io.to(to).emit('answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));
  socket.on('end-call', ({ to }) => { if (to) io.to(to).emit('partner-left'); });

  socket.on('disconnect', () => {
    if (waitingUser === socket.id) waitingUser = null;
    console.log('User disconnected:', socket.id);
  });
});

// ===== M-PESA PAYMENT =====
async function getMpesaToken() {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');
  const res = await axios.get(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

app.post('/api/mpesa/topup', async (req, res) => {
  const { phone, amount } = req.body;
  try {
    const token = await getMpesaToken();

    // Generate ONE timestamp in East Africa Time (UTC + 3)
    const eat = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const timestamp = eat.toISOString().replace(/\D/g, '').slice(0, 14);

    // Use the SAME timestamp for password
    const password = Buffer.from(
      `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString('base64');

    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phone,
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: 'https://globalcall-production.up.railway.app/api/mpesa/callback',
        AccountReference: 'GlobalCall',
        TransactionDesc: 'Video credits'
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log('✅ STK Push sent:', response.data);
    res.json(response.data);
  } catch (error) {
    console.error('❌ M-Pesa error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Payment initiation failed', details: error.response?.data });
  }
});

app.post('/api/mpesa/callback', (req, res) => {
  const { Body } = req.body;
  if (Body?.stkCallback?.ResultCode === 0) {
    const amount = Body.stkCallback.CallbackMetadata.Item.find(i => i.Name === 'Amount').Value;
    const phone = Body.stkCallback.CallbackMetadata.Item.find(i => i.Name === 'PhoneNumber').Value;
    console.log(`💰 Payment: ${phone} paid ${amount} KES`);
  } else {
    console.log('❌ Payment failed:', Body?.stkCallback?.ResultDesc);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
