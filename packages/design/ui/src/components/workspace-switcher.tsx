"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Plus, Building2, AlertCircle } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "./command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover";

export interface Workspace {
  id: string;
  name: string;
  slug?: string;
  description?: string;
}

export interface WorkspaceSwitcherProps {
  currentWorkspace: Workspace | null;
  workspaces: Workspace[];
  loading?: boolean;
  onSwitch: (workspaceId: string) => void;
  onCreateClick?: () => void;
  createDialog?: React.ReactNode;
}

export function WorkspaceSwitcher({
  currentWorkspace,
  workspaces,
  loading = false,
  onSwitch,
  onCreateClick,
  createDialog,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);

  if (loading) {
    return (
      <Button
        variant="outline"
        role="combobox"
        className="w-full justify-between"
        disabled
      >
        <Building2 className="mr-2 h-4 w-4" />
        Loading...
      </Button>
    );
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
          >
            <Building2 className="mr-2 h-4 w-4 shrink-0" />
            <span className="truncate">
              {currentWorkspace ? currentWorkspace.name : "Select workspace..."}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[200px] p-0">
          <Command>
            <CommandInput placeholder="Search workspace..." />
            <CommandList>
              <CommandEmpty>No workspace found.</CommandEmpty>
              <CommandGroup heading="Workspaces">
                {workspaces.map((workspace) => (
                  <CommandItem
                    key={workspace.id}
                    value={workspace.id}
                    onSelect={() => {
                      onSwitch(workspace.id);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        currentWorkspace?.id === workspace.id
                          ? "opacity-100"
                          : "opacity-0"
                      )}
                    />
                    {workspace.name}
                  </CommandItem>
                ))}
              </CommandGroup>
              {onCreateClick && (
                <>
                  <CommandSeparator />
                  <CommandGroup>
                    <CommandItem
                      onSelect={() => {
                        setOpen(false);
                        onCreateClick();
                      }}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Create Workspace
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {createDialog}
    </>
  );
}