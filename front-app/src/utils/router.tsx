import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
import Login from '../components/login/Login'
import { Box } from '@mui/material'

const rootRoute = createRootRoute({
  component: () => (
    <Box
      sx={{
        backgroundColor: '#395666',
        background:
          'radial-gradient(circle,rgba(57, 86, 102, 1) 0%, rgba(54, 105, 133, 1) 80%, rgba(42, 123, 155, 1) 100%);',
        minHeight: '100vh',
        width: '100%',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Outlet />
    </Box>
  ),
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: Login,
})

const routeTree = rootRoute.addChildren([loginRoute])

const router = createRouter({ routeTree })
export default router
