const mongoose = require('mongoose');

// 1. User Schema (Google OAuth Data)
const UserSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  name: { type: String },
  picture: { type: String },
  createdAt: { type: Date, default: Date.now }
});

// 2. Book Schema (Genre-based Catalog)
const BookSchema = new mongoose.Schema({
  title: { type: String, required: true },
  author: { type: String, required: true },
  genre: { type: String, required: true },
  price: { type: Number, required: true }
});

// 3. Cart Schema
const CartSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  items: [{
    bookId: { type: mongoose.Schema.Types.ObjectId, ref: 'Book' },
    quantity: { type: Number, default: 1 }
  }]
});

// 4. Order & Billing Schema
const OrderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  items: Array,
  totalAmount: Number,
  billingAddress: {
    street: String,
    city: String,
    zipCode: String
  },
  createdAt: { type: Date, default: Date.now }
});

module.exports = {
  User: mongoose.model('User', UserSchema),
  Book: mongoose.model('Book', BookSchema),
  Cart: mongoose.model('Cart', CartSchema),
  Order: mongoose.model('Order', OrderSchema)
};