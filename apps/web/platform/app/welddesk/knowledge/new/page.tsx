
import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  FileText,
  Plus,
  ChevronLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { WysiwygEditor } from '@/components/wysiwyg-editor/wysiwyg-editor';
import { useI18n } from '@/lib/i18n/provider';

export default function NewKnowledgeArticlePage() {
  const { t } = useI18n();
  const knp = t.helpdesk.knowledgeNewPage;
  const [title, setTitle] = useState('Untitled');
  const [content, setContent] = useState(`<p dir="ltr">${knp.startWriting}</p>`);
  const [showTabs, setShowTabs] = useState(false);

  const [tabs, setTabs] = useState([
    { id: 1, name: 'Tab 1', active: false },
    { id: 2, name: 'Tab 2', active: true },
    { id: 3, name: 'Tab 3', active: false },
  ]);

  const handleTabClick = (tabId: number) => {
    setTabs(tabs.map(tab => ({
      ...tab,
      active: tab.id === tabId
    })));
  };

  const handleAddTab = () => {
    const newTabId = tabs.length + 1;
    setTabs([...tabs, {
      id: newTabId,
      name: `Tab ${newTabId}`,
      active: false
    }]);
  };

  return (
    <div className="min-h-full bg-background relative flex flex-col">
      {/* Document Tabs Section */}
      <div className="absolute" style={{ top: '60px', left: '24px', zIndex: 5 }}>
        {!showTabs ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-sm hover:bg-muted"
            title={knp.documentTabs}
            onClick={() => setShowTabs(true)}
          >
            <FileText className="h-5 w-5" />
          </Button>
        ) : (
          <div className="w-48">
            <div className="flex items-center gap-2 mb-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowTabs(false)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-medium">{knp.documentTabs}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 ml-auto"
                title={knp.addNewTab}
                onClick={handleAddTab}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-1">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm",
                    tab.active ? "bg-blue-50 hover:bg-blue-100" : "hover:bg-muted"
                  )}
                  onClick={() => handleTabClick(tab.id)}
                >
                  <FileText className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="flex-1 truncate">{tab.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Editor */}
      <WysiwygEditor
        initialContent={content}
        initialTitle={title}
        onContentChange={setContent}
        onTitleChange={setTitle}
      />
    </div>
  );
}
