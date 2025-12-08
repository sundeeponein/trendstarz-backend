const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI;

async function testQuery() {
  try {
    await mongoose.connect(uri);
    console.log('Connected to MongoDB!');
    const Category = mongoose.connection.collection('categories');
    const categories = await Category.find({}).limit(5).toArray();
    console.log('Sample categories:', categories);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

testQuery();
