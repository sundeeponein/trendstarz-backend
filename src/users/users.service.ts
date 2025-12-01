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
    const influencer = await InfluencerModel.findByIdAndUpdate(id, { status: 'accepted' }, { new: true });
    if (influencer) return { message: 'User accepted', user: influencer };
    const brand = await BrandModel.findByIdAndUpdate(id, { status: 'accepted' }, { new: true });
    if (brand) return { message: 'User accepted', user: brand };
    return { message: 'User not found', id };
  }

  async declineUser(id: string) {
    const influencer = await InfluencerModel.findByIdAndUpdate(id, { status: 'declined' }, { new: true });
    if (influencer) return { message: 'User declined', user: influencer };
    const brand = await BrandModel.findByIdAndUpdate(id, { status: 'declined' }, { new: true });
    if (brand) return { message: 'User declined', user: brand };
    return { message: 'User not found', id };
  }

  async deleteUser(id: string) {
    const influencer = await InfluencerModel.findByIdAndUpdate(id, { status: 'deleted' }, { new: true });
    if (influencer) return { message: 'User deleted', user: influencer };
    const brand = await BrandModel.findByIdAndUpdate(id, { status: 'deleted' }, { new: true });
    if (brand) return { message: 'User deleted', user: brand };
    return { message: 'User not found', id };
  }

  async restoreUser(id: string) {
    const influencer = await InfluencerModel.findByIdAndUpdate(id, { status: 'pending' }, { new: true });
    if (influencer) return { message: 'User restored', user: influencer };
    const brand = await BrandModel.findByIdAndUpdate(id, { status: 'pending' }, { new: true });
    if (brand) return { message: 'User restored', user: brand };
    return { message: 'User not found', id };
  }

  async deletePermanently(id: string) {
    const influencer = await InfluencerModel.findByIdAndDelete(id);
    if (influencer) return { message: 'User permanently deleted', user: influencer };
    const brand = await BrandModel.findByIdAndDelete(id);
    if (brand) return { message: 'User permanently deleted', user: brand };
    return { message: 'User not found', id };
  }
}
