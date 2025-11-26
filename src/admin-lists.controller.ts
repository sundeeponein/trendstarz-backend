import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { CategoryModel, StateModel, DistrictModel, SocialMediaModel } from '../database/schemas/profile.schemas';

@Controller('admin')
export class AdminListsController {
  // Categories
  @Get('categories')
  async getCategories() {
    return CategoryModel.find();
  }
  @Post('categories')
  async addCategory(@Body() body: { name: string }) {
    return CategoryModel.create(body);
  }
  @Put('categories/:id')
  async updateCategory(@Param('id') id: string, @Body() body: any) {
    return CategoryModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete('categories/:id')
  async deleteCategory(@Param('id') id: string) {
    return CategoryModel.findByIdAndDelete(id);
  }

  // States
  @Get('states')
  async getStates() {
    return StateModel.find();
  }
  @Post('states')
  async addState(@Body() body: { name: string }) {
    return StateModel.create(body);
  }
  @Put('states/:id')
  async updateState(@Param('id') id: string, @Body() body: any) {
    return StateModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete('states/:id')
  async deleteState(@Param('id') id: string) {
    return StateModel.findByIdAndDelete(id);
  }

  // Districts
  @Get('districts')
  async getDistricts() {
    return DistrictModel.find().populate('state');
  }
  @Post('districts')
  async addDistrict(@Body() body: { name: string; state: string }) {
    return DistrictModel.create(body);
  }
  @Put('districts/:id')
  async updateDistrict(@Param('id') id: string, @Body() body: any) {
    return DistrictModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete('districts/:id')
  async deleteDistrict(@Param('id') id: string) {
    return DistrictModel.findByIdAndDelete(id);
  }

  // Social Media
  @Get('social-media')
  async getSocialMedia() {
    return SocialMediaModel.find();
  }
  @Post('social-media')
  async addSocialMedia(@Body() body: { name: string; tiers?: string[] }) {
    return SocialMediaModel.create(body);
  }
  @Put('social-media/:id')
  async updateSocialMedia(@Param('id') id: string, @Body() body: any) {
    return SocialMediaModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete('social-media/:id')
  async deleteSocialMedia(@Param('id') id: string) {
    return SocialMediaModel.findByIdAndDelete(id);
  }
}
