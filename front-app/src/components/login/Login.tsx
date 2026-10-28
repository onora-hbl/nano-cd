import { Box, Button, Typography } from '@mui/material'

function Login() {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Typography variant="h2">Nano CD login</Typography>
      <Button variant="contained">Login with Keycloak</Button>
    </Box>
  )
}

export default Login
