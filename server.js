const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ===== SUPABASE =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

// ===== M-PESA =====
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
    // Normalize phone: 0712... -> 254712..., +254 -> 254
    let cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.slice(1);
    if (cleanPhone.startsWith('254') === false && cleanPhone.length === 9) {
      cleanPhone = '254' + cleanPhone;
    }

    const token = await getMpesaToken();

    // Single EAT timestamp
    const eat = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const timestamp = eat.toISOString().replace(/\D/g, '').slice(0, 14);

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
        PartyA: cleanPhone,
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: cleanPhone,
        CallBackURL: 'https://globalcall-production.up.railway.app/api/mpesa/callback',
        AccountReference: cleanPhone,
        TransactionDesc: 'GlobalCall credits'
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

// ===== M-PESA CALLBACK =====
app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const { Body } = req.body;
    const callback = Body?.stkCallback;

    if (!callback) {
      return res.json({ ResultCode: 0, ResultDesc: 'No callback' });
    }

    if (callback.ResultCode === 0) {
      const items = callback.CallbackMetadata.Item;
      const amount = items.find(i => i.Name === 'Amount')?.Value;
      const phone = String(items.find(i => i.Name === 'PhoneNumber')?.Value);

      // Credits: 1 KES = 3600 sec / 130 KES per hour ≈ 27.7 sec per KES
      // Simpler: amount in KES * 27 seconds (since $1=130 KES=3600 sec)
      const creditsSeconds = Math.floor(amount * (3600 / 130));

      console.log(`💰 Payment: ${phone} paid ${amount} KES → ${creditsSeconds} sec`);

      // Find or create user, then add credits
      const { data: existing, error: findErr } = await supabase
        .from('users')
        .select('*')
        .eq('phone', phone)
        .maybeSingle();

      if (findErr) console.error('Supabase find error:', findErr);

      if (existing) {
        await supabase
          .from('users')
          .update({ balance_seconds: existing.balance_seconds + creditsSeconds })
          .eq('phone', phone);
      } else {
        await supabase
          .from('users')
          .insert({ phone, balance_seconds: creditsSeconds });
      }
    } else {
      console.log('❌ Payment failed:', callback.ResultDesc);
    }

    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (err) {
    console.error('Callback error:', err);
    res.json({ ResultCode: 0, ResultDesc: 'Handled' });
  }
});

// ===== USER BALANCE ENDPOINTS =====
app.get('/api/balance/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const { data, error } = await supabase
      .from('users')
      .select('balance_seconds')
      .eq('phone', phone)
      .maybeSingle();

    if (error) throw error;
    res.json({ balance: data?.balance_seconds || 0 });
  } catch (err) {
    console.error('Balance fetch error:', err);
    res.status(500).json({ balance: 0 });
  }
});

app.post('/api/balance/deduct', async (req, res) => {
  try {
    const { phone, seconds } = req.body;
    const { data: user } = await supabase
      .from('users')
      .select('balance_seconds')
      .eq('phone', phone)
      .maybeSingle();

    if (user) {
      const newBalance = Math.max(0, user.balance_seconds - seconds);
      await supabase
        .from('users')
        .update({ balance_seconds: newBalance })
        .eq('phone', phone);
      res.json({ balance: newBalance });
    } else {
      res.json({ balance: 0 });
    }
  } catch (err) {
    console.error('Deduct error:', err);
    res.status(500).json({ balance: 0 });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
