
import { useState, useRef } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Plus,
  MoreVertical,
  Trash2,
  Edit,
  Move,
  TrendingUp,
  Users,
  DollarSign,
  Activity,
  BarChart3,
  PieChart,
  LineChart,
  Target,
  Calendar,
  ShoppingCart,
  Settings,
  GripVertical,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslations } from '@weldsuite/i18n/client';

type WidgetType = 'line' | 'bar' | 'pie' | 'number' | 'list' | 'progress';
type WidgetSize = 'small' | 'medium' | 'large' | 'full';

interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  size: WidgetSize;
  data?: any;
  config?: {
    color?: string;
    metric?: string;
    dateRange?: string;
    dataSource?: string;
  };
  position: { x: number; y: number };
}

// Sample data for widgets
const generateSampleData = (type: WidgetType) => {
  switch (type) {
    case 'line':
      return {
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
        values: [30, 45, 35, 50, 40, 60],
      };
    case 'bar':
      return {
        labels: ['Product A', 'Product B', 'Product C', 'Product D'],
        values: [120, 190, 95, 140],
      };
    case 'pie':
      return {
        labels: ['Direct', 'Social', 'Email', 'Other'],
        values: [35, 25, 30, 10],
        colors: ['#3B82F6', '#10B981', '#F59E0B', '#6B7280'],
      };
    case 'number':
      return {
        value: 52340,
        change: 12.5,
        trend: 'up',
      };
    case 'list':
      return {
        items: [
          { name: 'John Doe', value: '$5,234', status: 'active' },
          { name: 'Jane Smith', value: '$3,120', status: 'active' },
          { name: 'Bob Johnson', value: '$2,890', status: 'pending' },
          { name: 'Alice Brown', value: '$1,567', status: 'active' },
        ],
      };
    case 'progress':
      return {
        current: 68,
        target: 100,
        label: 'of target',
      };
    default:
      return null;
  }
};

export function AnalyticsView() {
  const st = useTranslations();
  const [widgets, setWidgets] = useState<Widget[]>([
    {
      id: '1',
      type: 'number',
      title: st('sweep.weldflow.analyticsView.totalRevenue'),
      size: 'small',
      data: generateSampleData('number'),
      config: { color: '#3B82F6', metric: 'revenue' },
      position: { x: 0, y: 0 },
    },
    {
      id: '2',
      type: 'number',
      title: st('sweep.weldflow.analyticsView.activeUsers'),
      size: 'small',
      data: { value: 1234, change: 5.2, trend: 'up' },
      config: { color: '#10B981', metric: 'users' },
      position: { x: 1, y: 0 },
    },
    {
      id: '3',
      type: 'line',
      title: st('sweep.weldflow.analyticsView.revenueTrend'),
      size: 'medium',
      data: generateSampleData('line'),
      config: { color: '#3B82F6' },
      position: { x: 2, y: 0 },
    },
    {
      id: '4',
      type: 'bar',
      title: st('sweep.weldflow.analyticsView.salesByProduct'),
      size: 'medium',
      data: generateSampleData('bar'),
      config: { color: '#F59E0B' },
      position: { x: 0, y: 1 },
    },
  ]);

  const [isAddWidgetOpen, setIsAddWidgetOpen] = useState(false);
  const [editingWidget, setEditingWidget] = useState<Widget | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [draggedWidget, setDraggedWidget] = useState<string | null>(null);
  
  // New widget form state
  const [newWidget, setNewWidget] = useState({
    type: 'number' as WidgetType,
    title: '',
    size: 'medium' as WidgetSize,
    metric: '',
  });

  const addWidget = () => {
    const widget: Widget = {
      id: Date.now().toString(),
      type: newWidget.type,
      title: newWidget.title || st('sweep.weldflow.analyticsView.newWidget'),
      size: newWidget.size,
      data: generateSampleData(newWidget.type),
      config: {
        color: '#3B82F6',
        metric: newWidget.metric,
      },
      position: { x: 0, y: Math.max(...widgets.map(w => w.position.y), -1) + 1 },
    };
    setWidgets([...widgets, widget]);
    setIsAddWidgetOpen(false);
    setNewWidget({ type: 'number', title: '', size: 'medium', metric: '' });
  };

  const deleteWidget = (id: string) => {
    setWidgets(widgets.filter(w => w.id !== id));
  };

  const updateWidget = (id: string, updates: Partial<Widget>) => {
    setWidgets(widgets.map(w => w.id === id ? { ...w, ...updates } : w));
  };

  const renderWidgetContent = (widget: Widget) => {
    switch (widget.type) {
      case 'number':
        return (
          <div className="flex flex-col justify-center h-full">
            <div className="text-3xl font-bold">
              {widget.data?.value?.toLocaleString() || '0'}
            </div>
            {widget.data?.change && (
              <div className={cn(
                "flex items-center gap-1 text-sm mt-2",
                widget.data.trend === 'up' ? 'text-green-600' : 'text-red-600'
              )}>
                <TrendingUp className={cn(
                  "h-4 w-4",
                  widget.data.trend === 'down' && 'rotate-180'
                )} />
                {widget.data.change}%
              </div>
            )}
          </div>
        );

      case 'line':
        return (
          <div className="h-full flex items-center justify-center">
            <div className="w-full h-32 bg-gradient-to-r from-blue-50 to-blue-100 dark:from-blue-950 dark:to-blue-900 rounded flex items-end justify-around p-2">
              {widget.data?.values?.map((value: number, i: number) => (
                <div
                  key={i}
                  className="bg-blue-500 rounded-t"
                  style={{
                    width: '12%',
                    height: `${(value / Math.max(...widget.data.values)) * 100}%`,
                  }}
                />
              ))}
            </div>
          </div>
        );

      case 'bar':
        return (
          <div className="h-full flex items-center justify-center">
            <div className="w-full space-y-2">
              {widget.data?.labels?.slice(0, 4).map((label: string, i: number) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs w-20 truncate">{label}</span>
                  <div className="flex-1 bg-gray-200 dark:bg-accent rounded-full h-4">
                    <div
                      className="bg-yellow-500 h-4 rounded-full"
                      style={{
                        width: `${(widget.data.values[i] / Math.max(...widget.data.values)) * 100}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs w-12 text-right">{widget.data.values[i]}</span>
                </div>
              ))}
            </div>
          </div>
        );

      case 'pie':
        return (
          <div className="h-full flex items-center justify-center">
            <div className="relative w-32 h-32">
              <div className="absolute inset-0 rounded-full bg-gradient-to-br from-blue-500 to-purple-500" />
              <div className="absolute inset-4 rounded-full bg-white dark:bg-background" />
              <div className="absolute inset-0 flex items-center justify-center">
                <PieChart className="h-8 w-8 text-gray-400" />
              </div>
            </div>
          </div>
        );

      case 'list':
        return (
          <div className="space-y-2">
            {widget.data?.items?.slice(0, 4).map((item: any, i: number) => (
              <div key={i} className="flex items-center justify-between py-1">
                <span className="text-sm">{item.name}</span>
                <span className="text-sm font-medium">{item.value}</span>
              </div>
            ))}
          </div>
        );

      case 'progress':
        return (
          <div className="space-y-2">
            <div className="text-3xl font-bold">
              {widget.data?.current}%
            </div>
            <div className="w-full bg-gray-200 dark:bg-accent rounded-full h-2">
              <div
                className="bg-green-500 h-2 rounded-full transition-all"
                style={{ width: `${widget.data?.current}%` }}
              />
            </div>
            <div className="text-xs text-gray-500">
              {widget.data?.current} {widget.data?.label}
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  const getWidgetIcon = (type: WidgetType) => {
    switch (type) {
      case 'line': return <LineChart className="h-4 w-4" />;
      case 'bar': return <BarChart3 className="h-4 w-4" />;
      case 'pie': return <PieChart className="h-4 w-4" />;
      case 'number': return <Activity className="h-4 w-4" />;
      case 'list': return <Users className="h-4 w-4" />;
      case 'progress': return <Target className="h-4 w-4" />;
      default: return null;
    }
  };

  const getWidgetGridClass = (size: WidgetSize) => {
    switch (size) {
      case 'small': return 'col-span-1';
      case 'medium': return 'col-span-2';
      case 'large': return 'col-span-3';
      case 'full': return 'col-span-4';
      default: return 'col-span-2';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{st('sweep.weldflow.analyticsView.title')}</h1>
          <p className="text-muted-foreground mt-1">
            {st('sweep.weldflow.analyticsView.subtitle')}
          </p>
        </div>
        <Button onClick={() => setIsAddWidgetOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          {st('sweep.weldflow.analyticsView.addWidget')}
        </Button>
      </div>

      {/* Widget Grid */}
      <div className="grid grid-cols-4 gap-4">
        {widgets.map((widget) => (
          <Card
            key={widget.id}
            className={cn(
              "relative group hover:shadow-lg transition-shadow",
              getWidgetGridClass(widget.size),
              draggedWidget === widget.id && "opacity-50"
            )}
            draggable
            onDragStart={() => {
              setIsDragging(true);
              setDraggedWidget(widget.id);
            }}
            onDragEnd={() => {
              setIsDragging(false);
              setDraggedWidget(null);
            }}
          >
            {/* Widget Header */}
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                {getWidgetIcon(widget.type)}
                {widget.title}
              </CardTitle>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 cursor-move"
                >
                  <GripVertical className="h-3 w-3" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-6 w-6">
                      <MoreVertical className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setEditingWidget(widget)}>
                      <Edit className="h-3.5 w-3.5 mr-2" />
                      {st('sweep.weldflow.edit')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-red-600"
                      onClick={() => deleteWidget(widget.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2" />
                      {st('sweep.weldflow.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </CardHeader>
            <CardContent>
              {renderWidgetContent(widget)}
            </CardContent>
          </Card>
        ))}

        {/* Add Widget Placeholder */}
        {widgets.length === 0 && (
          <Card className="col-span-4 border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <BarChart3 className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">{st('sweep.weldflow.analyticsView.noWidgetsYet')}</h3>
              <p className="text-sm text-muted-foreground mb-4">
                {st('sweep.weldflow.analyticsView.noWidgetsDesc')}
              </p>
              <Button onClick={() => setIsAddWidgetOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                {st('sweep.weldflow.analyticsView.addWidget')}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Add Widget Modal */}
      <Dialog open={isAddWidgetOpen} onOpenChange={setIsAddWidgetOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{st('sweep.weldflow.analyticsView.addNewWidget')}</DialogTitle>
            <DialogDescription>
              {st('sweep.weldflow.analyticsView.addWidgetDialogDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Widget Type */}
            <div>
              <Label>{st('sweep.weldflow.analyticsView.widgetType')}</Label>
              <Select
                value={newWidget.type}
                onValueChange={(value) => setNewWidget({ ...newWidget, type: value as WidgetType })}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="number">
                    <div className="flex items-center gap-2">
                      <Activity className="h-4 w-4" />
                      {st('sweep.weldflow.analyticsView.numberCard')}
                    </div>
                  </SelectItem>
                  <SelectItem value="line">
                    <div className="flex items-center gap-2">
                      <LineChart className="h-4 w-4" />
                      {st('sweep.weldflow.analyticsView.lineChart')}
                    </div>
                  </SelectItem>
                  <SelectItem value="bar">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="h-4 w-4" />
                      {st('sweep.weldflow.analyticsView.barChart')}
                    </div>
                  </SelectItem>
                  <SelectItem value="pie">
                    <div className="flex items-center gap-2">
                      <PieChart className="h-4 w-4" />
                      {st('sweep.weldflow.analyticsView.pieChart')}
                    </div>
                  </SelectItem>
                  <SelectItem value="list">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      {st('sweep.weldflow.analyticsView.listView')}
                    </div>
                  </SelectItem>
                  <SelectItem value="progress">
                    <div className="flex items-center gap-2">
                      <Target className="h-4 w-4" />
                      {st('sweep.weldflow.analyticsView.progressBar')}
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Widget Title */}
            <div>
              <Label htmlFor="title">{st('sweep.weldflow.analyticsView.widgetTitleLabel')}</Label>
              <Input
                id="title"
                value={newWidget.title}
                onChange={(e) => setNewWidget({ ...newWidget, title: e.target.value })}
                placeholder={st('sweep.weldflow.analyticsView.widgetTitlePlaceholder')}
                className="mt-1"
              />
            </div>

            {/* Widget Size */}
            <div>
              <Label>{st('sweep.weldflow.analyticsView.size')}</Label>
              <Select
                value={newWidget.size}
                onValueChange={(value) => setNewWidget({ ...newWidget, size: value as WidgetSize })}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="small">{st('sweep.weldflow.analyticsView.smallOneColumn')}</SelectItem>
                  <SelectItem value="medium">{st('sweep.weldflow.analyticsView.mediumTwoColumns')}</SelectItem>
                  <SelectItem value="large">{st('sweep.weldflow.analyticsView.largeThreeColumns')}</SelectItem>
                  <SelectItem value="full">{st('sweep.weldflow.analyticsView.fullWidthFourColumns')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Data Source */}
            <div>
              <Label>{st('sweep.weldflow.analyticsView.dataSource')}</Label>
              <Select
                value={newWidget.metric}
                onValueChange={(value) => setNewWidget({ ...newWidget, metric: value })}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder={st('sweep.weldflow.analyticsView.selectAMetric')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="revenue">{st('sweep.weldflow.analyticsView.metricRevenue')}</SelectItem>
                  <SelectItem value="users">{st('sweep.weldflow.analyticsView.metricUsers')}</SelectItem>
                  <SelectItem value="orders">{st('sweep.weldflow.analyticsView.metricOrders')}</SelectItem>
                  <SelectItem value="conversion">{st('sweep.weldflow.analyticsView.metricConversionRate')}</SelectItem>
                  <SelectItem value="traffic">{st('sweep.weldflow.analyticsView.metricWebsiteTraffic')}</SelectItem>
                  <SelectItem value="sales">{st('sweep.weldflow.analyticsView.metricSales')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddWidgetOpen(false)}>
              {st('sweep.weldflow.cancel')}
            </Button>
            <Button onClick={addWidget}>
              {st('sweep.weldflow.analyticsView.addWidget')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Widget Modal */}
      {editingWidget && (
        <Dialog open={!!editingWidget} onOpenChange={() => setEditingWidget(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{st('sweep.weldflow.analyticsView.editWidget')}</DialogTitle>
              <DialogDescription>
                {st('sweep.weldflow.analyticsView.editWidgetDialogDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div>
                <Label htmlFor="edit-title">{st('sweep.weldflow.analyticsView.widgetTitleLabel')}</Label>
                <Input
                  id="edit-title"
                  value={editingWidget.title}
                  onChange={(e) => setEditingWidget({ ...editingWidget, title: e.target.value })}
                  className="mt-1"
                />
              </div>

              <div>
                <Label>{st('sweep.weldflow.analyticsView.size')}</Label>
                <Select
                  value={editingWidget.size}
                  onValueChange={(value) => setEditingWidget({ ...editingWidget, size: value as WidgetSize })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="small">{st('sweep.weldflow.analyticsView.small')}</SelectItem>
                    <SelectItem value="medium">{st('sweep.weldflow.analyticsView.medium')}</SelectItem>
                    <SelectItem value="large">{st('sweep.weldflow.analyticsView.large')}</SelectItem>
                    <SelectItem value="full">{st('sweep.weldflow.analyticsView.fullWidth')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingWidget(null)}>
                {st('sweep.weldflow.cancel')}
              </Button>
              <Button
                onClick={() => {
                  updateWidget(editingWidget.id, editingWidget);
                  setEditingWidget(null);
                }}
              >
                {st('sweep.weldflow.analyticsView.saveChanges')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}