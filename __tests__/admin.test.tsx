// biome-ignore lint/correctness/noUnusedImports: needed for JSX
import React from 'react';
import { render, screen } from '@testing-library/react';
import AdminAppPage from '../src/app/admin/page';
import '@testing-library/jest-dom';

test('renders admin app page', () => {
  render(<AdminAppPage />);
  expect(screen.getByText('Admin App')).toBeInTheDocument();
});
