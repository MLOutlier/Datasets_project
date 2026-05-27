import React, { Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuthStore } from "./store";
import { Layout } from "./components/Layout";

import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DatasetsPage } from "./pages/DatasetsPage";
import { DatasetDetailPage } from "./pages/DatasetDetailPage";
import { TasksPage } from "./pages/TasksPage";
import { LabelingPage } from "./pages/LabelingPage";
import { QualityPage } from "./pages/QualityPage";
import { FinancePage } from "./pages/FinancePage";
import { ProfilePage } from "./pages/ProfilePage";
import CreateProjectPage from "./pages/CreateProjectPage";
import ProjectDetailPage from "./pages/ProjectDetailPage";
import ProjectInstructionsPage from "./pages/ProjectInstructionsPage";
import ProjectsPage from "./pages/ProjectsPage";
import GenericLabelingPage from "./pages/GenericLabelingPage";

import AnnotatorProjectPage from "./pages/AnnotatorProjectPage";
import { LoadingSpinner } from "./components/LoadingSpinner";

const ProjectWorkflowPage = React.lazy(() => import("./pages/ProjectWorkflowPage"));
const VideoIntervalsPage = React.lazy(() => import("./pages/VideoIntervalsPage"));
const BBoxValidationPage = React.lazy(() => import("./pages/BBoxValidationPage"));
const AnnotationPage = React.lazy(() => import("./pages/AnnotationPage"));

function RequireAuth({ children }: { children: React.ReactElement }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

function LazyPage({ children }: { children: React.ReactElement }) {
  return <Suspense fallback={<LoadingSpinner size="lg" />}>{children}</Suspense>;
}

export default function App() {
  return (
    <Routes>
      {/* Публичные страницы — без Layout */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      {/* Защищённые страницы — с Layout */}

      {/* Проекты (важно: /projects ДО /projects/:projectId) */}
      <Route
        path="/projects"
        element={
          <RequireAuth>
            <Layout>
              <ProjectsPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/projects/create"
        element={
          <RequireAuth>
            <Layout>
              <CreateProjectPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/projects/:projectId"
        element={
          <RequireAuth>
            <Layout>
              <ProjectDetailPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/projects/:projectId/instructions"
        element={
          <RequireAuth>
            <Layout>
              <ProjectInstructionsPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/projects/:projectId/workflow"
        element={
          <RequireAuth>
            <Layout>
              <LazyPage>
                <ProjectWorkflowPage />
              </LazyPage>
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/labeling/intervals"
        element={
          <RequireAuth>
            <Layout>
              <LazyPage>
                <VideoIntervalsPage />
              </LazyPage>
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/labeling/bbox-validation"
        element={
          <RequireAuth>
            <Layout>
              <LazyPage>
                <BBoxValidationPage />
              </LazyPage>
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/labeling/generic/:projectId"
        element={
          <RequireAuth>
            <Layout>
              <GenericLabelingPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route path="/projects/:projectId/intervals" element={<Navigate to="/labeling/intervals" replace />} />
      <Route
        path="/labeling/projects/:projectId"
        element={
          <RequireAuth>
            <Layout>
              <AnnotatorProjectPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/labeling/assignments/:assignmentId"
        element={
          <RequireAuth>
            <Layout>
              <LazyPage>
                <AnnotationPage />
              </LazyPage>
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/projects/:projectId/annotation"
        element={<Navigate to="/labeling" replace />}
      />

      {/* Остальные маршруты */}
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout>
              <DashboardPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/datasets"
        element={
          <RequireAuth>
            <Layout>
              <DatasetsPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/datasets/:id"
        element={
          <RequireAuth>
            <Layout>
              <DatasetDetailPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/tasks"
        element={
          <RequireAuth>
            <Layout>
              <TasksPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/labeling"
        element={
          <RequireAuth>
            <Layout>
              <LabelingPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/quality"
        element={
          <RequireAuth>
            <Layout>
              <QualityPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/finance"
        element={
          <RequireAuth>
            <Layout>
              <FinancePage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/profile"
        element={
          <RequireAuth>
            <Layout>
              <ProfilePage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
