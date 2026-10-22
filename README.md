# QuickPic

Send a file from your phone to any computer with a 6-digit code. No login. The file is deleted after 10 minutes.

Supported: photos (JPG, PNG, WEBP, GIF, HEIC), videos (MP4, MOV, WEBM), audio (MP3, M4A, WAV), PDF and text files. Up to 10 files under one code, 50 MB each and 100 MB in total. Several files can be downloaded one by one or all together as a zip.

## Run it on your computer

1. Install Node.js (the LTS version) from https://nodejs.org
2. Open a terminal in this folder and run:

   ```
   npm install
   npm start
   ```

3. Open http://localhost:3000

## Files

- `server.js` - the server: takes uploads, gives out codes, deletes files after 10 minutes
- `public/index.html` - the whole website (page, styling, and script)
- `package.json` - the list of packages the server needs

## Settings

At the top of `server.js` you can change the code length, the expiry time, the size limit, and the rate limits.

## Put it online (Render)

1. Push this folder to a GitHub repository.
2. On https://render.com choose New > Web Service and pick the repository.
3. Build command: `npm install`. Start command: `npm start`.
4. Render gives you an `https://...onrender.com` address that works from any phone or computer.
