import { Injectable } from '@nestjs/common';
import { InfluencerProfileDto, BrandProfileDto } from './dto/profile.dto';
import { InfluencerModel, BrandModel } from '../database/schemas/profile.schemas';

@Injectable()
export class UsersService {
  async registerInfluencer(dto: InfluencerProfileDto) {
    // TODO: Add logic to save influencer profile to DB
    return { message: 'Influencer registered', data: dto };
  }

  async registerBrand(dto: BrandProfileDto) {
    // TODO: Add logic to save brand profile to DB
    return { message: 'Brand registered', data: dto };
  }

  async getInfluencers() {
    return await InfluencerModel.find({});
  }

  async getBrands() {
    return await BrandModel.find({});
  }

  async acceptUser(id: string) {
    // TODO: Update user status to 'accepted' in DB
    return { message: 'User accepted', id };
  }

  async declineUser(id: string) {
    // TODO: Update user status to 'declined' in DB
    return { message: 'User declined', id };
  }

  async deleteUser(id: string) {
    // TODO: Update user status to 'deleted' in DB
    return { message: 'User deleted', id };
  }

  async restoreUser(id: string) {
    // TODO: Restore user status from 'deleted' in DB
    return { message: 'User restored', id };
  }

  async deletePermanently(id: string) {
    // TODO: Permanently delete user from DB
    return { message: 'User permanently deleted', id };
  }
}
