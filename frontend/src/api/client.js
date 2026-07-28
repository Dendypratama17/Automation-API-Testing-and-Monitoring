import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

export const getEnvironments = () => api.get('/environments').then((r) => r.data);
export const createEnvironment = (data) => api.post('/environments', data).then((r) => r.data);
export const updateEnvironment = (id, data) => api.put(`/environments/${id}`, data).then((r) => r.data);
export const deleteEnvironment = (id) => api.delete(`/environments/${id}`).then((r) => r.data);
export const reorderEnvironments = (ids) => api.put('/environments/reorder', { ids }).then((r) => r.data);
export const importPostmanEnv = (data) => api.post('/environments/import/postman', data).then((r) => r.data);
export const importDotenv = (data) => api.post('/environments/import/dotenv', data).then((r) => r.data);

export const getEndpoints = (params) => api.get('/endpoints', { params }).then((r) => r.data);
export const updateEndpoint = (id, data) => api.put(`/endpoints/${id}`, data).then((r) => r.data);
export const deleteEndpoint = (id) => api.delete(`/endpoints/${id}`).then((r) => r.data);
export const duplicateEndpoint = (id) => api.post(`/endpoints/${id}/duplicate`).then((r) => r.data);
export const reorderEndpoints = (ids) => api.put('/endpoints/reorder', { ids }).then((r) => r.data);
export const importFromCurl = (data) => api.post('/endpoints/from-curl', data).then((r) => r.data);
export const importPostmanCollection = (data) => api.post('/endpoints/import/postman-collection', data).then((r) => r.data);

export const getFolders = (kind) => api.get('/folders', { params: { kind } }).then((r) => r.data);
export const createFolder = (data) => api.post('/folders', data).then((r) => r.data);
export const updateFolder = (id, data) => api.put(`/folders/${id}`, data).then((r) => r.data);
export const deleteFolder = (id) => api.delete(`/folders/${id}`).then((r) => r.data);

export const getFlows = (params) => api.get('/flows', { params }).then((r) => r.data);
export const getFlow = (id) => api.get(`/flows/${id}`).then((r) => r.data);
export const createFlow = (data) => api.post('/flows', data).then((r) => r.data);
export const updateFlow = (id, data) => api.put(`/flows/${id}`, data).then((r) => r.data);
export const deleteFlow = (id) => api.delete(`/flows/${id}`).then((r) => r.data);
export const duplicateFlow = (id) => api.post(`/flows/${id}/duplicate`).then((r) => r.data);
export const runFlow = (id, data) => api.post(`/flows/${id}/run`, data).then((r) => r.data);
export const batchRunFlows = (data) => api.post('/flows/batch-run', data).then((r) => r.data);
export const runFlowStep = (flowId, stepId, data) => api.post(`/flows/${flowId}/steps/${stepId}/run`, data).then((r) => r.data);
export const updateFlowStep = (flowId, stepId, data) => api.patch(`/flows/${flowId}/steps/${stepId}`, data).then((r) => r.data);
export const updateAllFlowSteps = (flowId, data) => api.patch(`/flows/${flowId}/steps`, data).then((r) => r.data);
export const getFlowRuns = (id, params) => api.get(`/flows/${id}/runs`, { params }).then((r) => r.data);
export const getFlowRun = (runId) => api.get(`/flow-runs/${runId}`).then((r) => r.data);
export const reorderFlows = (ids) => api.put('/flows/reorder', { ids }).then((r) => r.data);

export const getEndpointsOverview = (days) => api.get('/dashboard/endpoints-overview', { params: { days } }).then((r) => r.data);
export const getEndpointDetail = (id) => api.get(`/dashboard/endpoints/${id}/detail`).then((r) => r.data);
export const getEndpointTrend = (id, params) => api.get(`/dashboard/endpoints/${id}/trend`, { params }).then((r) => r.data);
export const getEnvComparison = (id) => api.get(`/dashboard/endpoints/${id}/env-comparison`).then((r) => r.data);
export const getLastRuns = (params) => api.get('/dashboard/last-runs', { params }).then((r) => r.data);
export const getLastFlowRuns = (params) => api.get('/dashboard/last-flow-runs', { params }).then((r) => r.data);
export const getAlerts = (params) => api.get('/dashboard/alerts', { params }).then((r) => r.data);
export const getAnalytics = (params) => api.get('/dashboard/analytics', { params }).then((r) => r.data);

export const getAuthCredentials = () => api.get('/auth-credentials').then((r) => r.data);
export const createAuthCredential = (data) => api.post('/auth-credentials', data).then((r) => r.data);
export const updateAuthCredential = (id, data) => api.put(`/auth-credentials/${id}`, data).then((r) => r.data);
export const deleteAuthCredential = (id) => api.delete(`/auth-credentials/${id}`).then((r) => r.data);
export const reorderAuthCredentials = (ids) => api.put('/auth-credentials/reorder', { ids }).then((r) => r.data);
export const testAuthCredentialLogin = (id) => api.post(`/auth-credentials/${id}/test-login`).then((r) => r.data);

export const getDefaultHeaders = () => api.get('/default-headers').then((r) => r.data);
export const createDefaultHeader = (data) => api.post('/default-headers', data).then((r) => r.data);
export const updateDefaultHeader = (id, data) => api.put(`/default-headers/${id}`, data).then((r) => r.data);
export const deleteDefaultHeader = (id) => api.delete(`/default-headers/${id}`).then((r) => r.data);
export const reorderDefaultHeaders = (ids) => api.put('/default-headers/reorder', { ids }).then((r) => r.data);

export const getTestFiles = () => api.get('/test-files').then((r) => r.data);
export const getTestFile = (id) => api.get(`/test-files/${id}`).then((r) => r.data);
export const createTestFile = (data) => api.post('/test-files', data).then((r) => r.data);
export const updateTestFile = (id, data) => api.put(`/test-files/${id}`, data).then((r) => r.data);
export const deleteTestFile = (id) => api.delete(`/test-files/${id}`).then((r) => r.data);
export const reorderTestFiles = (ids) => api.put('/test-files/reorder', { ids }).then((r) => r.data);

export const getSchedules = () => api.get('/schedules').then((r) => r.data);
export const createSchedule = (data) => api.post('/schedules', data).then((r) => r.data);
export const updateSchedule = (id, data) => api.put(`/schedules/${id}`, data).then((r) => r.data);
export const deleteSchedule = (id) => api.delete(`/schedules/${id}`).then((r) => r.data);
export const deleteScheduleForever = (id) => api.delete(`/schedules/${id}/permanent`).then((r) => r.data);
export const getScheduleHistory = (id) => api.get(`/schedules/${id}/history`).then((r) => r.data);
export const getScheduleRuns = (id, params) => api.get(`/schedules/${id}/runs`, { params }).then((r) => r.data);

export const getSettings = () => api.get('/settings').then((r) => r.data);
export const updateSetting = (key, value) => api.put(`/settings/${key}`, { value }).then((r) => r.data);

export default api;
