// Sample Mongoose models for config collections
import { Schema } from 'mongoose';

export const StateSchema = new Schema({
  state: String,
  visible: Boolean,
  districts: [
    {
      _id: String,
      name: String,
      visible: Boolean
    }
  ]
});

export const CategorySchema = new Schema({
  name: String,
  visible: Boolean
});

export const LanguageSchema = new Schema({
  name: String,
  visible: Boolean
});

export const TierSchema = new Schema({
  name: String,
  range: String,
  visible: Boolean
});

export const SocialMediaSchema = new Schema({
  name: String,
  visible: Boolean
});
