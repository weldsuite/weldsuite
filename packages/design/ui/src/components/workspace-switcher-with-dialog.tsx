"use client";

import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";
import { Textarea } from "./textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { WorkspaceSwitcher, Workspace } from "./workspace-switcher";

export interface WorkspaceSwitcherWithDialogProps {
  currentWorkspace: Workspace | null;
  workspaces: Workspace[];
  loading?: boolean;
  onSwitch: (workspaceId: string) => void;
  onCreate: (data: { name: string; slug: string; description?: string }) => Promise<void>;
  appName?: string;
}

export function WorkspaceSwitcherWithDialog({
  currentWorkspace,
  workspaces,
  loading = false,
  onSwitch,
  onCreate,
  appName = "this app",
}: WorkspaceSwitcherWithDialogProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    slug: "",
    description: "",
  });
  const [formErrors, setFormErrors] = useState<{
    name?: string;
    slug?: string;
    description?: string;
  }>({});

  const generateSlug = (name: string) => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 50);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    setFormData((prev) => ({
      ...prev,
      name,
      slug: prev.slug || generateSlug(name),
    }));
    setFormErrors((prev) => ({ ...prev, name: undefined }));
  };

  const handleSlugChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({ ...prev, slug: e.target.value }));
    setFormErrors((prev) => ({ ...prev, slug: undefined }));
  };

  const validateForm = () => {
    const errors: typeof formErrors = {};

    if (!formData.name) {
      errors.name = "Workspace name is required";
    } else if (formData.name.length > 50) {
      errors.name = "Workspace name must be less than 50 characters";
    } else if (!/^[a-zA-Z0-9\s-]+$/.test(formData.name)) {
      errors.name = "Name can only contain letters, numbers, spaces, and hyphens";
    }

    if (!formData.slug) {
      errors.slug = "Workspace slug is required";
    } else if (formData.slug.length > 50) {
      errors.slug = "Workspace slug must be less than 50 characters";
    } else if (!/^[a-z0-9-]+$/.test(formData.slug)) {
      errors.slug = "Slug can only contain lowercase letters, numbers, and hyphens";
    } else if (!/^[a-z]/.test(formData.slug)) {
      errors.slug = "Slug must start with a letter";
    } else if (!/[a-z0-9]$/.test(formData.slug)) {
      errors.slug = "Slug must end with a letter or number";
    }

    if (formData.description && formData.description.length > 200) {
      errors.description = "Description must be less than 200 characters";
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) {
      return;
    }

    setCreating(true);
    setError(null);

    try {
      await onCreate({
        name: formData.name,
        slug: formData.slug,
        description: formData.description || undefined,
      });
      setDialogOpen(false);
      setFormData({ name: "", slug: "", description: "" });
      setFormErrors({});
    } catch (err: any) {
      setError(err.message || "Failed to create workspace");
    } finally {
      setCreating(false);
    }
  };

  const handleDialogClose = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setFormData({ name: "", slug: "", description: "" });
      setFormErrors({});
      setError(null);
    }
  };

  return (
    <WorkspaceSwitcher
      currentWorkspace={currentWorkspace}
      workspaces={workspaces}
      loading={loading}
      onSwitch={onSwitch}
      onCreateClick={() => setDialogOpen(true)}
      createDialog={
        <Dialog open={dialogOpen} onOpenChange={handleDialogClose}>
          <DialogContent className="sm:max-w-[425px]">
            <form onSubmit={handleSubmit}>
              <DialogHeader>
                <DialogTitle>Create workspace</DialogTitle>
                <DialogDescription>
                  Add a new workspace to organize your {appName} data.
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 py-4">
                {error && (
                  <div className="bg-destructive/10 text-destructive p-3 rounded-md flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 mt-0.5" />
                    <span className="text-sm">{error}</span>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="name">
                    Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="name"
                    placeholder="My Workspace"
                    value={formData.name}
                    onChange={handleNameChange}
                  />
                  {formErrors.name && (
                    <p className="text-sm text-destructive flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      {formErrors.name}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="slug">
                    Slug <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="slug"
                    placeholder="my-workspace"
                    value={formData.slug}
                    onChange={handleSlugChange}
                  />
                  {formErrors.slug && (
                    <p className="text-sm text-destructive flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      {formErrors.slug}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Used in URLs and must be unique
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    placeholder="Optional description..."
                    rows={3}
                    value={formData.description}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        description: e.target.value,
                      }))
                    }
                  />
                  {formErrors.description && (
                    <p className="text-sm text-destructive flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      {formErrors.description}
                    </p>
                  )}
                </div>
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={creating}>
                  {creating ? "Creating..." : "Create workspace"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      }
    />
  );
}