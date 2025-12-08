const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI; // Use the same URI as your backend

mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log('MongoDB connection successful!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err);
    process.exit(1);
  });
