-- Allow uploaded logo URLs (and keep short Lucide names) on user_apps.icon.
ALTER TABLE "user_apps" ALTER COLUMN "icon" SET DATA TYPE text;
