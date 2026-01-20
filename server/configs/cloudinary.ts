import { v2 as cloudinary } from 'cloudinary';

// Configure cloudinary with the CLOUDINARY_URL from .env
// The URL format is: cloudinary://api_key:api_secret@cloud_name
const cloudinaryUrl = process.env.CLOUDINARY_URL;

if (!cloudinaryUrl) {
    throw new Error('CLOUDINARY_URL is not defined in environment variables');
}

// Parse the cloudinary URL
const match = cloudinaryUrl.match(/cloudinary:\/\/(\d+):([^@]+)@(.+)/);
if (!match) {
    throw new Error('Invalid CLOUDINARY_URL format');
}

const [, api_key, api_secret, cloud_name] = match;

cloudinary.config({
    cloud_name,
    api_key,
    api_secret,
    secure: true
});

export default cloudinary;
