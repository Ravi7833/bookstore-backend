require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const nodemailer = require('nodemailer');
const { User, Book, Cart, Order } = require('./models');
const cors = require('cors');

const app = express();

// Trust Azure Reverse Proxy for Secure Cookies
app.set('trust proxy', 1);

// Configure CORS to allow credentials from the Static Web App
app.use(cors({
  origin: 'https://red-bush-0fd114510.5.azurestaticapps.net',
  credentials: true
}));

app.use(express.json());

// MongoDB / Azure Cosmos DB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Successfully connected to Azure Cosmos DB / MongoDB'))
  .catch(err => console.error('Database Connection Error:', err));

// Session Setup with Cross-Site Cookie Support
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    sameSite: 'none',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// Google OAuth Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: 'https://app-bookstore-backend-b3b8f4eabrfja0d3.southeastasia-01.azurewebsites.net/auth/google/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await User.findOne({ googleId: profile.id });
      if (!user) {
        user = await User.create({
          googleId: profile.id,
          email: profile.emails[0].value,
          name: profile.displayName,
          picture: profile.photos[0]?.value
        });
      }
      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

// Middleware for Authenticated Routes
const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: 'Unauthorized. Please login via Google OAuth.' });
};

// ----------------------------------------------------
// Authentication Routes
// ----------------------------------------------------
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: 'https://red-bush-0fd114510.5.azurestaticapps.net?login=failed' }),
  (req, res) => {
    // Redirect back to React frontend upon successful login
    res.redirect('https://red-bush-0fd114510.5.azurestaticapps.net');
  }
);

// Get Currently Logged-In User Details
app.get('/api/me', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ user: req.user });
  } else {
    res.status(401).json({ message: 'Not authenticated' });
  }
});

// Logout Route
app.get('/auth/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    res.json({ message: 'Logged out successfully' });
  });
});

// ----------------------------------------------------
// API Endpoints: Books, Cart & Checkout
// ----------------------------------------------------

// Fetch Books (Filter by Genre)
app.get('/api/books', async (req, res) => {
  try {
    const { genre } = req.query;
    const filter = genre ? { genre } : {};
    const books = await Book.find(filter);
    res.json(books);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Add Single Custom Book
app.post('/api/books', async (req, res) => {
  try {
    const newBook = await Book.create(req.body);
    res.status(201).json(newBook);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Seed Initial Books (Utility Route)
app.post('/api/books/seed', async (req, res) => {
  try {
    await Book.insertMany([
      { title: 'Designing Data-Intensive Applications', author: 'Martin Kleppmann', genre: 'Tech', price: 45 },
      { title: 'The Hobbit', author: 'J.R.R. Tolkien', genre: 'Fantasy', price: 20 },
      { title: 'Dune', author: 'Frank Herbert', genre: 'Sci-Fi', price: 25 }
    ]);
    res.json({ message: 'Sample books added to Database!' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Add Item to Cart
app.post('/api/cart', isAuthenticated, async (req, res) => {
  try {
    const { bookId, quantity } = req.body;
    let cart = await Cart.findOne({ userId: req.user.id });

    if (!cart) {
      cart = new Cart({ userId: req.user.id, items: [] });
    }

    const existingIndex = cart.items.findIndex(item => item.bookId.toString() === bookId);
    if (existingIndex > -1) {
      cart.items[existingIndex].quantity += (quantity || 1);
    } else {
      cart.items.push({ bookId, quantity: quantity || 1 });
    }

    await cart.save();
    res.json({ message: 'Cart updated', cart });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Checkout & Send Billing Email
app.post('/api/checkout', isAuthenticated, async (req, res) => {
  try {
    const { billingAddress } = req.body;

    const cart = await Cart.findOne({ userId: req.user.id }).populate('items.bookId');
    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    let totalAmount = 0;
    const orderItems = cart.items.map(item => {
      const cost = item.bookId.price * item.quantity;
      totalAmount += cost;
      return { title: item.bookId.title, price: item.bookId.price, quantity: item.quantity, subtotal: cost };
    });

    const order = await Order.create({
      userId: req.user.id,
      items: orderItems,
      totalAmount,
      billingAddress
    });

    cart.items = [];
    await cart.save();

    // Send Order Billing Details Email
    await sendBillingEmail(req.user.email, order);

    res.json({ message: 'Checkout successful! Invoice sent to registered email.', orderId: order._id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Helper Function: Nodemailer Email Dispatch
async function sendBillingEmail(userEmail, order) {
console.log("DEBUG SMTP_USER:", process.env.SMTP_USER);
console.log("DEBUG SMTP_PASS Length:", process.env.SMTP_PASS ? process.env.SMTP_PASS.length : 0);
// Sanitize environment values explicitly
  const rawUser = process.env.SMTP_USER || 'rk00828431@gmail.com';
  const rawPass = process.env.SMTP_PASS || 'jbjjuqezrvrpddhv';

  const smtpUser = rawUser.replace(/['"\s]/g, '').trim();
  const smtpPass = rawPass.replace(/['"\s]/g, '').trim();

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: smtpUser,
      pass: smtpPass
    },
    tls: {
      rejectUnauthorized: false
    }
  });
  
  const itemsHtml = order.items.map(i => `<li><b>${i.title}</b> - ${i.quantity} x $${i.price} = $${i.subtotal}</li>`).join('');

  await transporter.sendMail({
    from: `"Bookstore Express" <${process.env.SMTP_USER}>`,
    to: userEmail,
    subject: `Order Invoice #${order._id}`,
    html: `
      <h2>Thank you for your purchase!</h2>
      <p>Order Summary:</p>
      <ul>${itemsHtml}</ul>
      <h3>Total Paid: $${order.totalAmount}</h3>
      <p><b>Billing Address:</b> ${order.billingAddress.street}, ${order.billingAddress.city}, ${order.billingAddress.zipCode}</p>
    `
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));