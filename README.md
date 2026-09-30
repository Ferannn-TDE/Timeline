# Moments Timeline

A two-person photo journal built with Next.js for Vercel. Editors add dated photos and captions; entries appear newest first and refresh automatically every 30 seconds. Portrait images display without cropping.

## Set up Supabase

1. Create a project at [Supabase](https://supabase.com/dashboard).
2. In **Storage**, create a bucket named `photo-journal`. Keep it **Private**. Set a 10 MB file limit and allow JPEG, PNG, and WebP if the dashboard offers those settings.
3. Open **SQL Editor** and run the full contents of `supabase/setup.sql` once.
4. In SQL Editor, run this with your actual email and the other editor's email:

   ```sql
   insert into public.journal_members(email)
   values ('you@example.com'), ('collaborator@example.com')
   on conflict (email) do nothing;
   ```

   Enter both addresses in lowercase. Only these addresses can read, add, edit, or remove entries and photos. Another person can request a sign-in link, but the journal will deny access.
5. In **Authentication → URL Configuration**, set the Site URL to your Vercel production URL after it is assigned. Add `http://localhost:3000/**` and `https://YOUR-PROJECT.vercel.app/**` to Redirect URLs as appropriate. Keep email sign-in enabled.
6. In the Supabase **Connect** dialog, copy the Project URL and **publishable** key. Do not use the service role or secret key in this app.

## Run locally

1. Copy `.env.example` to `.env.local`, then fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
2. Run `npm install`, then `npm run dev`.
3. Visit [localhost:3000](http://localhost:3000). Sign in with one of the approved email addresses.

## Deploy to Vercel

1. Create an empty GitHub repository and push this project folder. For a new repository:

   ```bash
   git init
   git add .
   git commit -m "Build Moments Timeline"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
   git push -u origin main
   ```

2. In [Vercel](https://vercel.com/new), choose **Add New → Project** and import that repository. The framework preset should be **Next.js** and the root directory should be the repository root.
3. Before clicking **Deploy**, enter the two `NEXT_PUBLIC_SUPABASE_...` values in **Environment Variables**. Select Production; also select Preview if you will use preview deployments.
4. Deploy, then copy the Vercel URL into Supabase **Authentication → URL Configuration** as in step 5 above.
5. Sign in as each approved account. Add a photo, add an older photo, edit a caption, and check that both accounts see the same ordering.

The `.env.local` file is ignored by Git. Never commit secret keys.

## Current scope

The website stores entries and private photos in Supabase. The Word document connection is not implemented yet; the page says so explicitly. The Word layout sample was provided separately. Uploads on the earlier private Site do not automatically transfer to this new database.
# Timeline
