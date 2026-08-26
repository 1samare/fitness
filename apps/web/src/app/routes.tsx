import { type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { MealsPage } from './pages/MealsPage';
import { PlanPage } from './pages/PlanPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { SetupPage } from './pages/SetupPage';
import { StubPage } from './pages/StubPage';
import { DataPage, type DataPageRuntime } from './pages/DataPage';
import {
  AssistantPage,
  type AssistantPageRuntime
} from './pages/AssistantPage';
import {
  IngredientPhotoPage,
  type IngredientPhotoPageRuntime
} from './pages/IngredientPhotoPage';

export interface AppRoute {
  readonly path: string;
  readonly title: string;
  readonly element: ReactNode;
}

export const APP_ROUTES: readonly [AppRoute, ...AppRoute[]] = [
  { path: '/', title: '启动与确认', element: <HomePage /> },
  { path: '/setup', title: '建档', element: <SetupPage /> },
  { path: '/plan', title: '每日营养', element: <PlanPage /> },
  { path: '/meals', title: '七日餐单', element: <MealsPage /> },
  {
    path: '/ingredients/photo',
    title: '图片识别',
    element: <StubPage title="食材图片识别" />
  },
  { path: '/assistant', title: '助手', element: <StubPage title="受限助手" /> },
  { path: '/data', title: '数据与导出', element: <StubPage title="数据与备份" /> },
  { path: '/privacy', title: '隐私与边界', element: <PrivacyPage /> }
];

export function AppRouteElements({
  assistantRuntime,
  ingredientPhotoRuntime,
  dataRuntime
}: {
  readonly assistantRuntime?: AssistantPageRuntime | undefined;
  readonly ingredientPhotoRuntime?: IngredientPhotoPageRuntime | undefined;
  readonly dataRuntime?: DataPageRuntime | undefined;
} = {}): JSX.Element {
  return (
    <Routes>
      {APP_ROUTES.map((route) => {
        const element = route.path === '/assistant'
          ? <AssistantPage runtime={assistantRuntime} />
          : route.path === '/ingredients/photo'
            ? <IngredientPhotoPage runtime={ingredientPhotoRuntime} />
            : route.path === '/data' && dataRuntime !== undefined
              ? <DataPage runtime={dataRuntime} />
            : route.element;
        return <Route key={route.path} path={route.path} element={element} />;
      })}
      <Route path="*" element={APP_ROUTES[0].element} />
    </Routes>
  );
}
