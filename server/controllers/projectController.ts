import { Request, Response } from 'express';
import * as Sentry from "@sentry/node"
import { prisma } from '../configs/prisma.js';
import cloudinary from '../configs/cloudinary.js';
import { GenerateContentConfig, HarmBlockThreshold, HarmCategory } from '@google/genai';
import fs from 'fs';
import path from 'path';
import ai from '../configs/ai.js';
import axios from 'axios';
import sharp from 'sharp';

const loadImage = (path: string, mimeType: string) => {
    return {
        inlineData: {
            data: fs.readFileSync(path).toString('base64'),
            mimeType
        }
    }
}

const MODEL_SAFE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg']);

const prepareImageForModel = async (file: any, tempPaths: string[]) => {
    if (MODEL_SAFE_MIME_TYPES.has(file.mimetype)) {
        return { path: file.path, mimeType: file.mimetype };
    }

    const convertedPath = `${file.path}-${Date.now()}-converted.png`;
    await sharp(file.path).png().toFile(convertedPath);
    tempPaths.push(convertedPath);

    return { path: convertedPath, mimeType: 'image/png' };
}

export const createProject = async (req: Request, res: Response) => {
    let tempProjectId: string ;
    const { userId } = req.auth();
    let isCreditDeducted = false;
    const {name = 'New Project', aspectRatio, userPrompt, productName, productDescription, targetLength = 30} = req.body;

    const images: any = req.files;

    if (!images || !Array.isArray(images) || images.length < 2 || !productName) {
        return res.status(400).json({message: 'Please provide at least 2 images and product name'})
    }

    const user = await prisma.user.findUnique({
        where: {id: userId},
    })

    if(!user || user.credits < 5){
        return res.status(401).json({message: 'Not enough credits. Please purchase more credits.'})
    }else{
        // deduct credit for image generation
        await prisma.user.update({
            where: {id: userId},
            data: {credits: {decrement: 5}},
        }).then(() => { isCreditDeducted = true;})
        
    }


    const tempConvertedPaths: string[] = [];

    try {
        let uploadedImages = await Promise.all(
            images.map(async(item: any) => {
                let result = await cloudinary.uploader.upload(item.path, { resource_type: "image" });
                return result.secure_url;
            })
        )

        const project = await prisma.project.create({
            data: {
                name, 
                userId,
                productName,
                productDescription,
                aspectRatio,
                userPrompt,
                targetLength: parseInt(targetLength),
                uploadedImages,
                isGenerating: true,
            }
        })

        tempProjectId = project.id;

        const model = "gemini-3-pro-image-preview";

        const generationConfig = {
            imageConfig: {
                aspectRatio: aspectRatio || '9:16',
                imageSize: "1k"
            },
            safetySettings:[
                {
                category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                 threshold: HarmBlockThreshold.OFF,
                     },
                     {
                category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                    threshold: HarmBlockThreshold.OFF,
                     },
                     {
                category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                    threshold: HarmBlockThreshold.OFF,
                     },
                {
                category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                    threshold: HarmBlockThreshold.OFF,
                     },
            ]
        }

        // ensure formats unsupported by Gemini are converted before encoding
        const [modelImageOne, modelImageTwo] = await Promise.all([
            prepareImageForModel(images[0], tempConvertedPaths),
            prepareImageForModel(images[1], tempConvertedPaths),
        ])

        const img1base64 = loadImage(modelImageOne.path, modelImageOne.mimeType)
        const img2base64 = loadImage(modelImageTwo.path, modelImageTwo.mimeType)

        const prompt = {
            text: `combine the person and product into a realistic photo.
            Make the person naturally hold or use the product.
            Match lighting, shadows, scale and perspective.
            Make the person stand in professional studio lighting.
            Output ecommerce-quality photo realistic imagery.
            ${userPrompt}`
        }
        // generate image using google gen ai
        const response = await ai.models.generateContent({
            model,
            contents: [ img1base64, img2base64, prompt,],
            config: generationConfig,
        })

        //check if reposne is valid 

        if(!response?.candidates?.[0]?.content?.parts){
            throw new Error('Unexpected response')
        }

        const parts = response.candidates[0].content.parts;
        let finalBuffer: Buffer | null = null

        for( const part of parts ){
            if(part.inlineData && part.inlineData.data){
                finalBuffer = Buffer.from(part.inlineData.data, 'base64')
            }
        }

        if(!finalBuffer){
            throw new Error('Failed to generate image')
        }

        const base64Image = `data:image/png;base64,${finalBuffer.toString('base64')}`;

        // upload generated image to cloudinary

        const uploadResult = await cloudinary.uploader.upload(base64Image, { resource_type: "image" });

        await prisma.project.update({
            where: { id: project.id },
            data:{
                generatedImage: uploadResult.secure_url,
                isGenerating: false,
            }
        })

        res.json({projectId: project.id})
        
    } catch (error: any) {
        console.error('Error in createProject:', error);
        if(tempProjectId!){
            // update project status
            await prisma.project.update({
                where: { id: tempProjectId },
                data:{
                    isGenerating: false,
                    error: error.message,} 
            })
        }

        if(isCreditDeducted){
            // refund credit
            await prisma.user.update({
                where: {id: userId},
                data: {credits: {increment: 5}},
            })
        }       

        Sentry.captureException(error);
        res.status(500).json({message: error.message})
    } finally {
        // Clean up converted files
        for (const filePath of tempConvertedPaths) {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }
        
        // Clean up original multer uploads
        if (images && Array.isArray(images)) {
            for (const image of images) {
                if (fs.existsSync(image.path)) {
                    fs.unlinkSync(image.path);
                }
            }
        }
    }
}
export const createVideo = async (req: Request, res: Response) => {
      const { userId } = req.auth();
    const { projectId } = req.body;
    let isCreditDeducted = false;

    const user = await prisma.user.findUnique({
        where: {id: userId},
    })

    if(!user || user.credits < 10){
        return res.status(401).json({message: 'Not enough credits. Please purchase more credits.'})
    }

    // deduct credits for video generation
    await prisma.user.update({
        where: {id: userId},
        data: {credits: {decrement: 10}},
    }).then(() => { isCreditDeducted = true;})

    try {
        const project = await prisma.project.findUnique({
            where: {id: projectId, userId},
            include: { user: true },
        })

        if(!project){
            return res.status(404).json({message: 'Project not found'})
        }

        if(project.isGenerating){
            return res.status(400).json({message: 'Generation already in progress'})
        }

    if(project.generatedVideo){
        return res.status(400).json({message: 'Video already generated'})
        }

    await prisma.project.update({
        where: { id: projectId },
        data:{
            isGenerating: true,
        }
    })

    const prompt = `A professional product showcase video. The person is displaying and presenting the ${project.productName}. ${project.productDescription ? `Product details: ${project.productDescription}. ` : ''}Smooth camera movement, natural presentation style, commercial quality lighting.`

    const model = 'veo-3.1-generate-preview'

    if(!project.generatedImage){
        throw new Error('No generated image found for the project')
    }

    const image = await axios.get(project.generatedImage, { responseType: 'arraybuffer' });
    const imageBytes: any = Buffer.from(image.data);

    let operation: any = await ai.models.generateVideos({
        model,
        prompt,
        image: {
            imageBytes: imageBytes.toString('base64'),
            mimeType: 'image/png',
        },
        config:{
            aspectRatio: project?.aspectRatio || '9:16',
            numberOfVideos: 1,
            resolution: '720p',
            duration: project.targetLength || 30,
        }
    })

    console.log('Initial operation:', JSON.stringify(operation, null, 2));

    while(!operation.done){
        console.log('Waiting for video generation to complete...')
        await new Promise(resolve => setTimeout(resolve, 10000));
        operation = await ai.operations.getVideosOperation({
            operation: operation, 
        });
        console.log('Operation status:', operation.done ? 'completed' : 'in progress');
    }

    console.log('Final operation response:', JSON.stringify(operation.response, null, 2));

    const filename = `${userId}-${Date.now()}.mp4`;
    const filePath = path.join('videos', filename);

    // create the images directory if it doesn't exist
   
        fs.mkdirSync('videos', {recursive: true});

        if(!operation.response || !operation.response.generatedVideos || !operation.response.generatedVideos[0]){
            console.error('Video generation failed. Response:', operation.response);
            
            // Check for specific error messages from the API
            let errorMessage = 'Video generation failed';
            
            if (operation.response?.raiMediaFilteredReasons?.[0]) {
                errorMessage = operation.response.raiMediaFilteredReasons[0];
            } else if (operation.response?.error?.message) {
                errorMessage = operation.response.error.message;
            } else if (operation.error?.message) {
                errorMessage = operation.error.message;
            } else if (typeof operation.response === 'string') {
                errorMessage = operation.response;
            }
            
            // Make celebrity detection error more user-friendly
            if (errorMessage.toLowerCase().includes('celebrity') || errorMessage.toLowerCase().includes('likeness')) {
                errorMessage = "The AI detected a celebrity or recognizable person in the image. Please try with a different person's photo or use a more generic model image.";
            }
            
            throw new Error(errorMessage);
        }

        // download thw video 

        await ai.files.download({
            file: operation.response.generatedVideos[0].video,
            downloadPath: filePath,
        })

        //upload to cloudinary

        const uploadResult = await cloudinary.uploader.upload(filePath, { resource_type: "video" });

        await prisma.project.update({
            where: { id: project.id },
                data: {
                    generatedVideo: uploadResult.secure_url,
                    isGenerating: false,
                }
             
        })

        //remove the video file from disk after upload 
        fs.unlinkSync(filePath);

        res.json({message: 'Video generation completed successfully', videoUrl: uploadResult.secure_url})

    } catch (error: any) {
        console.error('Error in createVideo:', error);

        
            // update project status
            await prisma.project.update({
                where: { id: projectId, userId },
                data:{
                    isGenerating: false,
                    error: error.message,} 
            })
        

        if(isCreditDeducted){
            // refund credit
            await prisma.user.update({
                where: {id: userId},
                data: {credits: {increment: 10}},
            })
        }       

        Sentry.captureException(error);
        res.status(500).json({message: error.message})
    }
}
export const getAllPublishedProjects = async (req: Request, res: Response) => {

    

    try {
        const projects = await prisma.project.findMany({
            where: {isPublished: true},
            
        })

        res.json({projects})
        } catch (error: any) {
        Sentry.captureException(error);
        res.status(500).json({message: error.message})
    }
}
export const deleteProjects = async (req: Request, res: Response) => {
    try {

        const {userId} = req.auth() 
        const {projectId} = req.params

        const project = await prisma.project.findUnique({
            where: { id: projectId as string, userId},
        })

        if(!project){
            return res.status(404).json({message: 'Project not found'})
        }

        await prisma.project.delete({
            where: { id: projectId as string}
        })

        res.json({message: 'Project deleted successfully'})
        
    } catch (error: any) {
        Sentry.captureException(error);
        res.status(500).json({message: error.message})
    }
}