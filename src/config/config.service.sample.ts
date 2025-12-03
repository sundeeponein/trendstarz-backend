// Sample NestJS service for config
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

@Injectable()
export class ConfigService {
  constructor(
    @InjectModel('State') private stateModel: Model<any>,
    @InjectModel('Category') private categoryModel: Model<any>,
    @InjectModel('Language') private languageModel: Model<any>,
    @InjectModel('Tier') private tierModel: Model<any>,
    @InjectModel('SocialMedia') private socialMediaModel: Model<any>
  ) {}

  async getStates() {
    return this.stateModel.find({});
  }
  async updateState(id: string, update: any) {
    return this.stateModel.findByIdAndUpdate(id, update, { new: true });
  }

  async getCategories() {
    return this.categoryModel.find({});
  }
  async updateCategory(id: string, update: any) {
    return this.categoryModel.findByIdAndUpdate(id, update, { new: true });
  }

  async getLanguages() {
    return this.languageModel.find({});
  }
  async updateLanguage(id: string, update: any) {
    return this.languageModel.findByIdAndUpdate(id, update, { new: true });
  }

  async getTiers() {
    return this.tierModel.find({});
  }
  async updateTier(id: string, update: any) {
    return this.tierModel.findByIdAndUpdate(id, update, { new: true });
  }

  async getSocialMedia() {
    return this.socialMediaModel.find({});
  }
  async updateSocialMedia(id: string, update: any) {
    return this.socialMediaModel.findByIdAndUpdate(id, update, { new: true });
  }
}
