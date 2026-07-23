import { auth } from '@auth0/nextjs-auth0';

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: string[];
}

export interface PagedResult<T> {
  items: T[];
  totalCount: number;
  pageNumber: number;
  pageSize: number;
  totalPages: number;
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000') {
    this.baseUrl = baseUrl;
  }

  private async getHeaders(): Promise<HeadersInit> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    // Get Auth0 token for server-side requests
    if (typeof window === 'undefined') {
      try {
        const session = await auth();
        if (session?.accessToken) {
          headers.Authorization = `Bearer ${session.accessToken}`;
        }
      } catch (error) {
        console.error('Failed to get auth token:', error);
      }
    } else {
      // Client-side: get token from session endpoint
      try {
        const response = await fetch('/api/auth/token');
        if (response.ok) {
          const { accessToken } = await response.json();
          if (accessToken) {
            headers.Authorization = `Bearer ${accessToken}`;
          }
        }
      } catch (error) {
        console.error('Failed to get client token:', error);
      }
    }

    return headers;
  }

  async get<T>(path: string, params?: Record<string, any>): Promise<ApiResponse<T>> {
    try {
      const url = new URL(`${this.baseUrl}${path}`);
      if (params) {
        Object.keys(params).forEach(key => {
          if (params[key] !== undefined && params[key] !== null) {
            url.searchParams.append(key, params[key].toString());
          }
        });
      }

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: await this.getHeaders(),
      });

      return await response.json();
    } catch (error) {
      console.error('API GET error:', error);
      return {
        success: false,
        message: 'Network error occurred',
      };
    }
  }

  async post<T>(path: string, data?: any): Promise<ApiResponse<T>> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: await this.getHeaders(),
        body: JSON.stringify(data),
      });

      return await response.json();
    } catch (error) {
      console.error('API POST error:', error);
      return {
        success: false,
        message: 'Network error occurred',
      };
    }
  }

  async put<T>(path: string, data?: any): Promise<ApiResponse<T>> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'PUT',
        headers: await this.getHeaders(),
        body: JSON.stringify(data),
      });

      return await response.json();
    } catch (error) {
      console.error('API PUT error:', error);
      return {
        success: false,
        message: 'Network error occurred',
      };
    }
  }

  async delete<T>(path: string): Promise<ApiResponse<T>> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'DELETE',
        headers: await this.getHeaders(),
      });

      return await response.json();
    } catch (error) {
      console.error('API DELETE error:', error);
      return {
        success: false,
        message: 'Network error occurred',
      };
    }
  }
}

export const apiClient = new ApiClient();

// Area-specific API clients
export const dashboardApi = {
  analytics: {
    getOverview: (startDate?: Date, endDate?: Date) => 
      apiClient.get('/api/dashboard/analytics/overview', { startDate, endDate }),
    getRevenue: (startDate?: Date, endDate?: Date, groupBy?: string) =>
      apiClient.get('/api/dashboard/analytics/revenue', { startDate, endDate, groupBy }),
    getSalesFunnel: (startDate?: Date, endDate?: Date) =>
      apiClient.get('/api/dashboard/analytics/sales-funnel', { startDate, endDate }),
    getTopProducts: (limit?: number, startDate?: Date, endDate?: Date) =>
      apiClient.get('/api/dashboard/analytics/top-products', { limit, startDate, endDate }),
    getCustomerInsights: () =>
      apiClient.get('/api/dashboard/analytics/customer-insights'),
    getPerformanceMetrics: () =>
      apiClient.get('/api/dashboard/analytics/performance-metrics'),
  },
};

export const commerceApi = {
  products: {
    getAll: (page?: number, pageSize?: number, categoryId?: string, search?: string) =>
      apiClient.get('/api/commerce/products', { page, pageSize, categoryId, search }),
    getById: (id: string) =>
      apiClient.get(`/api/commerce/products/${id}`),
    create: (data: any) =>
      apiClient.post('/api/commerce/products', data),
    update: (id: string, data: any) =>
      apiClient.put(`/api/commerce/products/${id}`, data),
    delete: (id: string) =>
      apiClient.delete(`/api/commerce/products/${id}`),
    updateStock: (id: string, quantity: number) =>
      apiClient.put(`/api/commerce/products/${id}/stock`, { quantity }),
  },
  orders: {
    getAll: (page?: number, pageSize?: number, status?: string, customerId?: string) =>
      apiClient.get('/api/commerce/orders', { page, pageSize, status, customerId }),
    getById: (id: string) =>
      apiClient.get(`/api/commerce/orders/${id}`),
    create: (data: any) =>
      apiClient.post('/api/commerce/orders', data),
    updateStatus: (id: string, status: string, comment?: string) =>
      apiClient.put(`/api/commerce/orders/${id}/status`, { status, comment }),
    getStatistics: (startDate?: Date, endDate?: Date) =>
      apiClient.get('/api/commerce/orders/statistics', { startDate, endDate }),
  },
  categories: {
    getAll: () =>
      apiClient.get('/api/commerce/categories'),
    getById: (id: string) =>
      apiClient.get(`/api/commerce/categories/${id}`),
    create: (data: any) =>
      apiClient.post('/api/commerce/categories', data),
    update: (id: string, data: any) =>
      apiClient.put(`/api/commerce/categories/${id}`, data),
    delete: (id: string) =>
      apiClient.delete(`/api/commerce/categories/${id}`),
  },
};

export const accountingApi = {
  invoices: {
    getAll: (page?: number, pageSize?: number, status?: string, customerId?: string) =>
      apiClient.get('/api/accounting/invoices', { page, pageSize, status, customerId }),
    getById: (id: string) =>
      apiClient.get(`/api/accounting/invoices/${id}`),
    create: (data: any) =>
      apiClient.post('/api/accounting/invoices', data),
    updateStatus: (id: string, status: string) =>
      apiClient.put(`/api/accounting/invoices/${id}/status`, { status }),
    send: (id: string, recipients: string[], subject?: string, message?: string) =>
      apiClient.post(`/api/accounting/invoices/${id}/send`, { recipients, subject, message }),
    recordPayment: (id: string, amount: number, paymentMethod?: string) =>
      apiClient.post(`/api/accounting/invoices/${id}/payment`, { amount, paymentMethod }),
    getSummary: (startDate?: Date, endDate?: Date) =>
      apiClient.get('/api/accounting/invoices/summary', { startDate, endDate }),
  },
};

export const adminApi = {
  users: {
    getAll: (page?: number, pageSize?: number, search?: string, roleId?: string) =>
      apiClient.get('/api/admin/users', { page, pageSize, search, roleId }),
    getById: (id: string) =>
      apiClient.get(`/api/admin/users/${id}`),
    updateRoles: (id: string, roleIds: string[]) =>
      apiClient.put(`/api/admin/users/${id}/roles`, { roleIds }),
    suspend: (id: string, reason: string) =>
      apiClient.post(`/api/admin/users/${id}/suspend`, { reason }),
    activate: (id: string) =>
      apiClient.post(`/api/admin/users/${id}/activate`),
    delete: (id: string) =>
      apiClient.delete(`/api/admin/users/${id}`),
  },
  roles: {
    getAll: () =>
      apiClient.get('/api/admin/roles'),
    getById: (id: string) =>
      apiClient.get(`/api/admin/roles/${id}`),
    create: (data: any) =>
      apiClient.post('/api/admin/roles', data),
    update: (id: string, data: any) =>
      apiClient.put(`/api/admin/roles/${id}`, data),
    delete: (id: string) =>
      apiClient.delete(`/api/admin/roles/${id}`),
    getPermissions: () =>
      apiClient.get('/api/admin/roles/permissions'),
  },
};

export const warehouseApi = {
  inventory: {
    getAll: (page?: number, pageSize?: number, warehouseId?: string, productId?: string, lowStock?: boolean) =>
      apiClient.get('/api/warehouse/inventory', { page, pageSize, warehouseId, productId, lowStock }),
    getMovements: (warehouseId?: string, productId?: string, startDate?: Date, endDate?: Date) =>
      apiClient.get('/api/warehouse/inventory/movements', { warehouseId, productId, startDate, endDate }),
    adjust: (warehouseId: string, productId: string, newQuantity: number, reason?: string) =>
      apiClient.post('/api/warehouse/inventory/adjust', { warehouseId, productId, newQuantity, reason }),
    transfer: (fromWarehouseId: string, toWarehouseId: string, productId: string, quantity: number, reason?: string) =>
      apiClient.post('/api/warehouse/inventory/transfer', { fromWarehouseId, toWarehouseId, productId, quantity, reason }),
    getReorderItems: () =>
      apiClient.get('/api/warehouse/inventory/reorder'),
  },
};

export const crmApi = {
  customers: {
    getAll: (page?: number, pageSize?: number, search?: string, segment?: string, isActive?: boolean) =>
      apiClient.get('/api/crm/customers', { page, pageSize, search, segment, isActive }),
    getById: (id: string) =>
      apiClient.get(`/api/crm/customers/${id}`),
    create: (data: any) =>
      apiClient.post('/api/crm/customers', data),
    update: (id: string, data: any) =>
      apiClient.put(`/api/crm/customers/${id}`, data),
    addActivity: (id: string, data: any) =>
      apiClient.post(`/api/crm/customers/${id}/activities`, data),
    addNote: (id: string, title: string, content: string) =>
      apiClient.post(`/api/crm/customers/${id}/notes`, { title, content }),
    getSegments: () =>
      apiClient.get('/api/crm/customers/segments'),
  },
};