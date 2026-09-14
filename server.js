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

// ===== SMART MATCHING =====
// Each waiting user stores: { id, prefs, joinedAt }
let waitingUsers = [];

// Compatible if both have "any" OR their preferences overlap
function isCompatible(a, b) {
  const langOk = a.lang === 'any' || b.lang === 'any' || a.lang === b.lang;
  const countryOk = a.country === 'any' || b.country === 'any' || a.country === b.country;
  return langOk && countryOk;
}

// Find the best match for a new user
function findMatch(newUser) {
  // First, try exact preference match
  for (let i = 0; i < waitingUsers.length; i++) {
    if (isCompatible(newUser.prefs, waitingUsers[i].prefs)) {
      return i;
    }
  }
  // Fallback: if new user wants "any", match with anyone
  if (newUser.prefs.lang === 'any' && newUser.prefs.country === 'any') {
    return waitingUsers.length > 0 ? 0 : -1;
  }
  // No match found
  return -1;
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('start-match', (prefs) => {
    // Clean prefs
    const userPrefs = {
      lang: prefs?.lang || 'any',
      country: prefs?.country || 'any'
    };

    const newUser = { id: socket.id, prefs: userPrefs, joinedAt: Date.now() };
    const matchIndex = findMatch(newUser);

    if (matchIndex !== -1) {
      // Found a match — pair them
      const partner = waitingUsers.splice(matchIndex, 1)[0];
      socket.join(partner.id);
      io.to(partner.id).emit('match-found', { partnerId: socket.id, initiator: true });
      socket.emit('match-found', { partnerId: partner.id, initiator: false });

      console.log(`🤝 Matched: ${partner.id} (${JSON.stringify(partner.prefs)}) ↔ ${socket.id} (${JSON.stringify(userPrefs)})`);
    } else {
      // No match — add to queue
      // Remove any existing entry for this socket first
      waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
      waitingUsers.push(newUser);
      socket.emit('waiting');
      console.log(`⏳ Waiting: ${socket.id} prefs=${JSON.stringify(userPrefs)} queue=${waitingUsers.length}`);
    }
  });

  // Cancel waiting (user closed the searching screen)
  socket.on('cancel-match', () => {
    waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
  });

  socket.on('offer', ({ to, offer }) => io.to(to).emit('offer', { from: socket.id, offer }));
  socket.on('answer', ({ to, answer }) => io.to(to).emit('answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));
  socket.on('end-call', ({ to }) => { if (to) io.to(to).emit('partner-left'); });

  socket.on('disconnect', () => {
    waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
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
    let cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.slice(1);
    if (!cleanPhone.startsWith('254') && cleanPhone.length === 9) {
      cleanPhone = '254' + cleanPhone;
    }

    const token = await getMpesaToken();
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
        CallBackURL: 'https://globalcall-production-ee02.up.railway.app/api/mpesa/callback',
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
    if (!callback) return res.json({ ResultCode: 0, ResultDesc: 'No callback' });

    if (callback.ResultCode === 0) {
      const items = callback.CallbackMetadata.Item;
      const amount = items.find(i => i.Name === 'Amount')?.Value;
      const phone = String(items.find(i => i.Name === 'PhoneNumber')?.Value);
      const creditsSeconds = Math.floor(amount * (3600 / 130));

      console.log(`💰 Payment: ${phone} paid ${amount} KES → ${creditsSeconds} sec`);

      const { data: existing } = await supabase
        .from('users')
        .select('*')
        .eq('phone', phone)
        .maybeSingle();

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

// ===== BALANCE =====
app.get('/api/balance/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const { data } = await supabase
      .from('users')
      .select('balance_seconds')
      .eq('phone', phone)
      .maybeSingle();
    res.json({ balance: data?.balance_seconds || 0 });
  } catch (err) {
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
    res.status(500).json({ balance: 0 });
  }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
