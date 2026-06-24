import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(new URL('./public', import.meta.url).pathname));

app.get('/autofill-test', (req, res) => {
  res.sendFile(new URL('./public/autofill-test.html', import.meta.url).pathname);
});

// A simple health check route
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/api/autofill/map/test', async (req, res) => {
  const { userInstruction, domSchema } = req.body;
  if (!userInstruction || !domSchema) {
    return res.status(400).json({ error: 'userInstruction and domSchema are required' });
  }

  try {
    const { buildAutoMappings } = await import('./src/pages/api/autofill/map.js');
    const mockVault = {
      profiles: {
        primary: {
          personalDetails: {
            fullName: 'Chintan Jayantibhai Prajapati',
            dob: '1990-01-01',
            address: '123 Main St, Mumbai, Maharashtra, 400001',
          },
          identities: {
            aadhaar: {
              aadhaarNumber: '1234 5678 9012',
            },
          },
          documents: [
            {
              otherDetails: {
                email: 'chintan@example.com',
              },
            },
          ],
        },
        spouse: {
          personalDetails: {
            fullName: 'Manisha Prajapati',
          },
        },
        mother: {
          personalDetails: {
            fullName: 'Geetaben',
          },
        },
        children_0: {
          personalDetails: {
            fullName: 'Dhyana Prajapati',
          },
        },
      },
      familyTree: {
        primary: 'Chintan Jayantibhai Prajapati',
        spouse: 'Manisha Prajapati',
        mother: 'Geetaben',
        children: ['Dhyana Prajapati'],
      },
    };

    const mappings = buildAutoMappings(domSchema, mockVault, userInstruction);
    const summary = {
      total: mappings.length,
      mapped: mappings.filter((m) => m.value !== null && m.value !== undefined && m.value !== '').length,
      unmapped: mappings.filter((m) => m.value === null || m.value === undefined || m.value === '').length,
    };
    return res.status(200).json({ mappings, summary, mockVault });
  } catch (error) {
    console.error('Test mapping failed:', error);
    return res.status(500).json({ error: 'Test mapping failed', detail: error.message });
  }
});

// Helper to wrap any handler with error catching
function route(handlerImport) {
  return async (req, res) => {
    try {
      const handler = (await handlerImport()).default;
      await handler(req, res);
    } catch (error) {
      console.error('Route error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error', detail: error.message });
      }
    }
  };
}

app.post('/api/autofill/map',  route(() => import('./src/pages/api/autofill/map.js')));
app.post('/api/auth/login',    route(() => import('./src/pages/api/auth/login.js')));
app.post('/api/auth/signup',   route(() => import('./src/pages/api/auth/signup.js')));
app.post('/api/vault/sync',    route(() => import('./src/pages/api/vault/sync.js')));
app.post('/api/vault/seed',    route(() => import('./src/pages/api/vault/seed.js')));
app.get('/api/vault/status',   route(() => import('./src/pages/api/vault/status.js')));
app.get('/api/vault/trees',    route(() => import('./src/pages/api/vault/trees.js')));
app.post('/api/vault/trees',   route(() => import('./src/pages/api/vault/trees.js')));
app.get('/api/vault/profiles', route(() => import('./src/pages/api/vault/profiles.js')));



app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
