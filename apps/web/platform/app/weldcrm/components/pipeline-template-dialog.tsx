
import * as React from "react";
import {
  Dialog,
  DialogContent,
} from "@weldsuite/ui/components/dialog";
import { Input } from "@weldsuite/ui/components/input";
import { Badge } from "@weldsuite/ui/components/badge";
import { Button } from "@weldsuite/ui/components/button";
import { Search, TrendingUp, Briefcase, Users, X, DollarSign, UserCheck, Wallet, Megaphone, Sparkles, Rocket, PenTool } from "lucide-react";
import { cn } from "@/lib/utils";
import { getTranslations } from "@/lib/i18n";
import { useTranslations } from '@weldsuite/i18n/client';

export interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  icon: React.ElementType;
  tags: string[];
  category: string;
  badge?: string;
}

const USE_CASE_ICONS: Record<string, React.ElementType> = {
  "all": Sparkles,
  "sales": DollarSign,
  "investing": TrendingUp,
  "recruiting": Users,
  "marketing": Megaphone,
  "customer-success": UserCheck,
  "fundraising": Wallet,
  "finance": DollarSign,
  "hr": Users,
  "operations": Briefcase,
  "pr": Megaphone,
  "startups": Rocket,
  "venture-capital": TrendingUp,
  "content": PenTool,
};

const TEMPLATE_META: Array<{ id: string; icon: React.ElementType; category: string; badge?: string }> = [
  { id: "content-co-creation", icon: PenTool, category: "content", badge: "People" },
  { id: "customer-success", icon: UserCheck, category: "customer-success", badge: "Companies" },
  { id: "employee-onboarding", icon: Users, category: "hr", badge: "People" },
  { id: "outsourcing", icon: Briefcase, category: "operations", badge: "People" },
  { id: "press-outreach", icon: Megaphone, category: "pr", badge: "People" },
  { id: "sales-pipeline", icon: TrendingUp, category: "sales", badge: "Companies" },
  { id: "recruiting", icon: Users, category: "recruiting", badge: "People" },
  { id: "project-pipeline", icon: Briefcase, category: "operations", badge: "Companies" },
  { id: "product-launch", icon: Rocket, category: "operations", badge: "Companies" },
  { id: "partnership-pipeline", icon: Sparkles, category: "sales", badge: "Companies" },
];

interface PipelineTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectTemplate: (template: PipelineTemplate) => void;
}

export function PipelineTemplateDialog({
  open,
  onOpenChange,
  onSelectTemplate,
}: PipelineTemplateDialogProps) {
  const t = getTranslations('crm');
  const st = useTranslations();
  const [searchQuery, setSearchQuery] = React.useState("");
  const [selectedCategory, setSelectedCategory] = React.useState<string | null>('all');

  const templates: PipelineTemplate[] = TEMPLATE_META.map((meta) => ({
    id: meta.id,
    icon: meta.icon,
    category: meta.category,
    badge: meta.badge,
    name: st(`sweep.weldcrm.pipelineTemplateDialog.templates.${meta.id}.name`),
    description: st(`sweep.weldcrm.pipelineTemplateDialog.templates.${meta.id}.description`),
    tags: (st(`sweep.weldcrm.pipelineTemplateDialog.templates.${meta.id}.tags`) as string).split('|'),
  }));

  const USE_CASES = [
    { id: "all", label: t.pipelineTemplateDialog.useCaseAll, icon: USE_CASE_ICONS["all"] },
    { id: "sales", label: t.pipelineTemplateDialog.useCaseSales, icon: USE_CASE_ICONS["sales"] },
    { id: "investing", label: t.pipelineTemplateDialog.useCaseInvesting, icon: USE_CASE_ICONS["investing"] },
    { id: "recruiting", label: t.pipelineTemplateDialog.useCaseRecruiting, icon: USE_CASE_ICONS["recruiting"] },
    { id: "marketing", label: t.pipelineTemplateDialog.useCaseMarketing, icon: USE_CASE_ICONS["marketing"] },
    { id: "customer-success", label: t.pipelineTemplateDialog.useCaseCustomerSuccess, icon: USE_CASE_ICONS["customer-success"] },
    { id: "fundraising", label: t.pipelineTemplateDialog.useCaseFundraising, icon: USE_CASE_ICONS["fundraising"] },
    { id: "finance", label: t.pipelineTemplateDialog.useCaseFinance, icon: USE_CASE_ICONS["finance"] },
    { id: "hr", label: t.pipelineTemplateDialog.useCaseHR, icon: USE_CASE_ICONS["hr"] },
    { id: "operations", label: t.pipelineTemplateDialog.useCaseOperations, icon: USE_CASE_ICONS["operations"] },
    { id: "pr", label: t.pipelineTemplateDialog.useCasePR, icon: USE_CASE_ICONS["pr"] },
    { id: "startups", label: t.pipelineTemplateDialog.useCaseStartups, icon: USE_CASE_ICONS["startups"] },
    { id: "venture-capital", label: t.pipelineTemplateDialog.useCaseVentureCapital, icon: USE_CASE_ICONS["venture-capital"] },
    { id: "content", label: t.pipelineTemplateDialog.useCaseContent, icon: USE_CASE_ICONS["content"] },
  ];

  const filteredTemplates = templates.filter(template => {
    const matchesSearch = template.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      template.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      template.tags.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesCategory = !selectedCategory || selectedCategory === 'all' || template.category === selectedCategory;

    return matchesSearch && matchesCategory;
  });

  const handleTemplateClick = (template: PipelineTemplate) => {
    onSelectTemplate(template);
    onOpenChange(false);
    setSearchQuery("");
    setSelectedCategory('all');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[1250px] !w-[1250px] h-[800px] p-0 gap-0 flex flex-col overflow-hidden" showCloseButton={false}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <h2 className="text-lg font-semibold">{t.pipelineTemplateDialog.heading}</h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Left Sidebar - Categories */}
          <div className="w-72 shrink-0 border-r overflow-y-auto custom-scrollbar bg-gray-50 dark:bg-background">
            <div className="p-4">
              <p className="text-xs font-medium text-gray-500 dark:text-muted-foreground mb-3 px-2">
                {t.pipelineTemplateDialog.useCasesLabel}
              </p>
              <div className="space-y-1">
                {USE_CASES.map((category) => {
                  const Icon = category.icon;
                  return (
                    <Button
                      key={category.id}
                      variant="ghost"
                      onClick={() => setSelectedCategory(selectedCategory === category.id ? null : category.id)}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left h-auto justify-start",
                        selectedCategory === category.id
                          ? "bg-gray-100 dark:bg-secondary text-gray-900 dark:text-foreground"
                          : "text-gray-700 dark:text-muted-foreground hover:bg-gray-50 dark:hover:bg-secondary/50"
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      <span>{category.label}</span>
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right Content - Templates */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Search */}
            <div className="pl-4 pr-6 pt-4 pb-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder={t.pipelineTemplateDialog.searchPlaceholder}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            {/* Templates Grid */}
            <div className="flex-1 overflow-y-auto px-4 pb-6 custom-scrollbar">
              <div className="grid grid-cols-3 gap-4">
                {filteredTemplates.map((template) => {
                  const Icon = template.icon;
                  return (
                    <Button
                      key={template.id}
                      variant="ghost"
                      onClick={() => handleTemplateClick(template)}
                      className="border rounded-lg hover:bg-gray-50 dark:hover:bg-secondary transition-colors text-left flex flex-col overflow-hidden h-auto justify-start items-start p-0"
                    >
                      {/* Image/Icon at top */}
                      <div className="w-full h-40 border-b flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
                        <Icon className="w-14 h-14 text-gray-700 dark:text-muted-foreground" />
                      </div>
                      {/* Content */}
                      <div className="p-4 flex flex-col gap-1.5">
                        {/* Name */}
                        <h3 className="font-semibold text-sm">{template.name}</h3>
                        {/* Description */}
                        <p className="text-sm text-gray-600 dark:text-muted-foreground line-clamp-2">
                          {template.description}
                        </p>
                        {/* Tags */}
                        <div className="flex flex-wrap gap-2 mt-1">
                          {template.tags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="text-xs font-normal">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </Button>
                  );
                })}
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t flex items-center justify-end shrink-0 bg-white dark:bg-background">
              <Button
                onClick={() => {
                  onSelectTemplate({
                    id: 'blank',
                    name: st('sweep.weldcrm.pipelineTemplateDialog.blankPipeline'),
                    description: '',
                    icon: TrendingUp,
                    tags: [],
                    category: ''
                  });
                  onOpenChange(false);
                  setSearchQuery("");
                  setSelectedCategory('all');
                }}
              >
                {t.pipelineTemplateDialog.startFromScratch}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
