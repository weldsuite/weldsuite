'use client';

import * as React from 'react';
import {
  Key,
  Plus,
  Copy,
  MoreVertical,
  Trash,
  Shield,
  AlertCircle,
  CheckCircle,
  Eye,
  EyeOff,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { Button } from './button';
import { Input } from './input';
import { Label } from './label';
import { Textarea } from './textarea';
import { Badge } from './badge';
import { Checkbox } from './checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from './alert';
import { toast } from 'sonner';
import { format } from 'date-fns';

// Define available API scopes
const API_SCOPES = {
  // Commerce
  'read:products': 'Read product information',
  'write:products': 'Create and update products',
  'delete:products': 'Delete products',
  'read:orders': 'Read order information',
  'write:orders': 'Create and update orders',
  'read:customers': 'Read customer information',
  'write:customers': 'Create and update customers',
  
  // Accounting
  'read:invoices': 'Read invoice information',
  'write:invoices': 'Create and update invoices',
  'read:transactions': 'Read transaction information',
  'write:transactions': 'Create transactions',
  
  // Warehouse
  'read:inventory': 'Read inventory information',
  'write:inventory': 'Update inventory',
  'read:warehouses': 'Read warehouse information',
  
  // General
  'read:workspace': 'Read workspace information',
  'write:workspace': 'Update workspace settings',
  'admin:all': 'Full administrative access'
};

interface ApiKey {
  id: string;
  name: string;
  key: string;
  createdAt: Date;
  lastUsed?: Date | null;
  permissions?: string[];
  environment?: string;
  isActive?: boolean;
}

interface ApiKeysContentProps {
  apiKeys: ApiKey[];
  loading: boolean;
  onAddNew: () => void;
  onDelete: (id: string) => void;
  showForm: boolean;
  formData: any;
  setFormData: (data: any) => void;
  onFormSubmit: (e: React.FormEvent) => void;
  setShowForm: (show: boolean) => void;
  formMode: 'add' | 'edit';
  newApiToken?: { token: string; name: string } | null;
  setNewApiToken?: (token: { token: string; name: string } | null) => void;
}

export function ApiKeysContent({
  apiKeys,
  loading,
  onAddNew,
  onDelete,
  showForm,
  formData,
  setFormData,
  onFormSubmit,
  setShowForm,
  formMode,
  newApiToken,
  setNewApiToken,
}: ApiKeysContentProps) {
  const [showCreateDialog, setShowCreateDialog] = React.useState(false);
  const [copiedToken, setCopiedToken] = React.useState(false);
  const [creatingToken, setCreatingToken] = React.useState(false);
  const [selectedScopes, setSelectedScopes] = React.useState<string[]>([]);
  
  // Use the passed newApiToken or local state
  const newTokenData = newApiToken || null;
  const setNewTokenData = setNewApiToken || (() => {});

  const handleCreateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingToken(true);
    
    // Set the permissions/scopes in formData
    const updatedFormData = {
      ...formData,
      permissions: selectedScopes,
    };
    setFormData(updatedFormData);
    
    // Call the parent's form submit handler
    await onFormSubmit(e);
    
    // The parent should update the apiKeys list
    setShowCreateDialog(false);
    setSelectedScopes([]);
    setCreatingToken(false);
  };

  const copyToken = (token: string) => {
    navigator.clipboard.writeText(token);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 2000);
    toast.success('API key copied to clipboard');
  };

  const getEnvironmentBadgeVariant = (env?: string) => {
    switch (env) {
      case 'production':
        return 'destructive';
      case 'staging':
        return 'secondary';
      case 'development':
        return 'outline';
      default:
        return 'default';
    }
  };

  if (showForm || showCreateDialog) {
    return (
      <Dialog open={true} onOpenChange={(open) => {
        if (!open) {
          setShowCreateDialog(false);
          setShowForm(false);
          setSelectedScopes([]);
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create API Token</DialogTitle>
            <DialogDescription>
              Create a new API token for machine-to-machine authentication
            </DialogDescription>
          </DialogHeader>
          
          <form onSubmit={handleCreateToken} className="space-y-4">
            <div>
              <Label htmlFor="token-name">Token Name</Label>
              <Input
                id="token-name"
                value={formData.name || ''}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Production API"
                required
              />
              <p className="text-xs text-muted-foreground mt-1">
                A descriptive name for this token
              </p>
            </div>
            
            <div>
              <Label htmlFor="token-description">Description (Optional)</Label>
              <Textarea
                id="token-description"
                value={formData.description || ''}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Describe what this token will be used for..."
                rows={3}
              />
            </div>
            
            <div>
              <Label htmlFor="token-environment">Environment</Label>
              <Select
                value={formData.environment || 'production'}
                onValueChange={(value) => setFormData({ ...formData, environment: value })}
              >
                <SelectTrigger id="token-environment">
                  <SelectValue placeholder="Select environment" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="production">Production</SelectItem>
                  <SelectItem value="staging">Staging</SelectItem>
                  <SelectItem value="development">Development</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <Label>API Scopes</Label>
              <p className="text-xs text-muted-foreground mb-3">
                Select the permissions this token should have
              </p>
              <div className="grid grid-cols-2 gap-3 max-h-64 overflow-y-auto">
                {Object.entries(API_SCOPES).map(([scope, description]) => (
                  <div key={scope} className="flex items-start space-x-2">
                    <Checkbox
                      id={`scope-${scope}`}
                      checked={selectedScopes.includes(scope)}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedScopes([...selectedScopes, scope]);
                        } else {
                          setSelectedScopes(selectedScopes.filter(s => s !== scope));
                        }
                      }}
                    />
                    <div className="space-y-0.5">
                      <label
                        htmlFor={`scope-${scope}`}
                        className="text-sm font-medium cursor-pointer"
                      >
                        {scope}
                      </label>
                      <p className="text-xs text-muted-foreground">
                        {description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            <div>
              <Label htmlFor="token-expires">Expiration</Label>
              <Select
                value={formData.expiresIn || '90'}
                onValueChange={(value) => setFormData({ ...formData, expiresIn: value })}
              >
                <SelectTrigger id="token-expires">
                  <SelectValue placeholder="Select expiration" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">30 days</SelectItem>
                  <SelectItem value="60">60 days</SelectItem>
                  <SelectItem value="90">90 days</SelectItem>
                  <SelectItem value="365">1 year</SelectItem>
                  <SelectItem value="never">Never</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowCreateDialog(false);
                  setShowForm(false);
                  setSelectedScopes([]);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creatingToken || !formData.name || selectedScopes.length === 0}>
                {creatingToken ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create Token'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <div className="space-y-6">
      {/* New Token Alert */}
      {newTokenData && (
        <Alert className="border-green-200 bg-green-50">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertTitle>API Token Created Successfully</AlertTitle>
          <AlertDescription className="mt-2 space-y-2">
            <p>
              Your API token "{newTokenData.name}" has been created. Make sure to copy it now as you
              won't be able to see it again.
            </p>
            <div className="flex items-center gap-2 mt-3">
              <code className="relative rounded bg-white px-2 py-1 font-mono text-sm border flex-1">
                {newTokenData.token}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyToken(newTokenData.token)}
              >
                {copiedToken ? (
                  <>
                    <CheckCircle className="h-4 w-4 mr-1" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4 mr-1" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={() => setNewTokenData(null)}
            >
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Manage API tokens for programmatic access to your organizations
        </p>
        <Button onClick={() => {
          setFormData({});
          setShowCreateDialog(true);
          setShowForm(true);
        }}>
          <Plus className="h-4 w-4 mr-2" />
          Create API Token
        </Button>
      </div>

      <div className="border rounded-lg">
        {apiKeys.length === 0 ? (
          <div className="text-center py-12">
            <Key className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground mb-4">No API tokens yet</p>
            <Button
              variant="outline"
              onClick={() => {
                setFormData({});
                setShowCreateDialog(true);
                setShowForm(true);
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              Create your first token
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Environment</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <code className="text-xs bg-muted px-2 py-1 rounded">
                        {key.key}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => copyToken(key.key)}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    {key.environment && (
                      <Badge variant={getEnvironmentBadgeVariant(key.environment)}>
                        {key.environment}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">
                      {format(new Date(key.createdAt), 'MMM d, yyyy')}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">
                      {key.lastUsed ? format(new Date(key.lastUsed), 'MMM d, yyyy') : 'Never'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={key.isActive !== false ? 'default' : 'secondary'}>
                      {key.isActive !== false ? 'Active' : 'Revoked'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem>
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Regenerate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => onDelete(key.id)}
                          className="text-destructive"
                        >
                          <Trash className="h-4 w-4 mr-2" />
                          Revoke
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* API Documentation Section */}
      <div className="border rounded-lg p-4 space-y-3">
        <h4 className="font-medium">Quick Start</h4>
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Include your API token in the Authorization header:
          </p>
          <pre className="bg-muted p-2 rounded text-xs">
            {`Authorization: Bearer YOUR_API_TOKEN`}
          </pre>
          <p className="text-sm text-muted-foreground">
            Example request:
          </p>
          <pre className="bg-muted p-2 rounded text-xs">
{`curl -X GET https://api.weldsuite.com/v1/products \\
  -H "Authorization: Bearer wld_live_xxxxx"`}
          </pre>
        </div>
      </div>
    </div>
  );
}