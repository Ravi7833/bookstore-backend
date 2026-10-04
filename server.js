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
app.use(cors());
app.use(express.json());

// MongoDB / Cosmos DB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Successfully connected to Azure Cosmos DB / MongoDB'))
  .catch(err => console.error('Database Connection Error:', err));

// Session Setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret_key',
  resave: false,
  saveUninitialized: false
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
  const user = await User.findById(id);
  done(null, user);
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
  passport.authenticate('google', { failureRedirect: '/login-failed' }),
  (req, res) => res.json({ message: 'Authentication successful!', user: req.user })
);

// ----------------------------------------------------
// API Endpoints: Books, Cart & Checkout
// ----------------------------------------------------

// Fetch Books (Filter by Genre)
app.get('/api/books', async (req, res) => {
  const { genre } = req.query;
  const filter = genre ? { genre } : {};
  const books = await Book.find(filter);
  res.json(books);
});

// Seed Initial Books (Utility Route)
app.post('/api/books/seed', async (req, res) => {
  await Book.insertMany([
    { title: 'Designing Data-Intensive Applications', author: 'Martin Kleppmann', genre: 'Tech', price: 45 },
    { title: 'The Hobbit', author: 'J.R.R. Tolkien', genre: 'Fantasy', price: 20 },
    { title: 'Dune', author: 'Frank Herbert', genre: 'Sci-Fi', price: 25 }
  ]);
  res.json({ message: 'Sample books added to Database!' });
});

// Add Item to Cart
app.post('/api/cart', isAuthenticated, async (req, res) => {
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
});

// Checkout & Send Billing Email
app.post('/api/checkout', isAuthenticated, async (req, res) => {
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
});

// Helper Function: Nodemailer Email Dispatch
async function sendBillingEmail(userEmail, order) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
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

// Add Single Custom Book
app.post('/api/books', async (req, res) => {
  try {
    const newBook = await Book.create(req.body);
    res.status(201).json(newBook);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));