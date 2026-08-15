-- ═══════════════════════════════════════════════════════════════════════════
-- Seed · las 6 preguntas fijas + la de cierre (PRD §6)
-- Idempotente vía upsert. La fuente de verdad en código es lib/quiz/bank.ts;
-- esta tabla existe para poder editar copy sin desplegar.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path = holaamigo, public;

insert into holaamigo.quiz_questions
  (id, category, prompt, help_text, input_type, options, required, sort_order)
values
  ('main_offer', 'oferta',
   'Si tuvieras que vender una sola cosa este trimestre, ¿cuál sería?',
   'Una frase basta. Es lo que va a guiar todo lo demás.',
   'text', '[]'::jsonb, true, 10),

  ('ticket_band', 'numeros',
   '¿Cuánto factura un cliente promedio la primera vez?',
   'El valor del primer contrato o primera compra, no el lifetime value.',
   'single',
   '[{"value":"lt_500","label":"Menos de USD 500","mid":300},
     {"value":"500_2k","label":"USD 500 – 2.000","mid":1200},
     {"value":"2k_10k","label":"USD 2.000 – 10.000","mid":5000},
     {"value":"10k_50k","label":"USD 10.000 – 50.000","mid":25000},
     {"value":"gt_50k","label":"Más de USD 50.000","mid":80000}]'::jsonb,
   true, 20),

  ('rev_band', 'numeros',
   '¿Cuánto factura la empresa al mes hoy?',
   'Aproximado está bien. Nadie va a auditar esto.',
   'single',
   '[{"value":"lt_10k","label":"Menos de USD 10k","mid":5000},
     {"value":"10k_50k","label":"USD 10k – 50k","mid":28000},
     {"value":"50k_200k","label":"USD 50k – 200k","mid":110000},
     {"value":"200k_1m","label":"USD 200k – 1M","mid":500000},
     {"value":"gt_1m","label":"Más de USD 1M","mid":1500000}]'::jsonb,
   true, 30),

  ('sales_team', 'equipo',
   '¿Cuántas personas se dedican a vender o a contestarle a los clientes?',
   null,
   'single',
   '[{"value":"0","label":"Nadie de tiempo completo","mid":0},
     {"value":"1_2","label":"1 o 2","mid":1.5},
     {"value":"3_5","label":"3 a 5","mid":4},
     {"value":"6_15","label":"6 a 15","mid":10},
     {"value":"gt_15","label":"Más de 15","mid":25}]'::jsonb,
   true, 40),

  ('dormant_db', 'data',
   '¿Cuántos contactos tienes guardados que mostraron interés y nunca compraron?',
   'CRM, Excel, WhatsApp, la libreta — todo junto. Es la pregunta que más plata mueve.',
   'single',
   '[{"value":"unknown","label":"No sé","mid":800},
     {"value":"lt_500","label":"Menos de 500","mid":250},
     {"value":"500_2k","label":"500 – 2.000","mid":1200},
     {"value":"2k_10k","label":"2.000 – 10.000","mid":5500},
     {"value":"gt_10k","label":"Más de 10.000","mid":18000}]'::jsonb,
   true, 50),

  ('main_channel', 'motor',
   '¿De dónde salen hoy la mayoría de tus clientes?',
   'Puedes marcar varios.',
   'multi',
   '[{"value":"referidos","label":"Referidos"},
     {"value":"pauta","label":"Pauta"},
     {"value":"organico","label":"Orgánico / SEO"},
     {"value":"outbound","label":"Outbound"},
     {"value":"eventos","label":"Eventos"},
     {"value":"marketplace","label":"Marketplace"}]'::jsonb,
   true, 60),

  ('goal_deadline', 'cierre',
   '¿Para cuándo necesitas ver resultados?',
   null,
   'single',
   '[{"value":"week","label":"Esta semana"},
     {"value":"month","label":"Este mes"},
     {"value":"quarter","label":"Este trimestre"},
     {"value":"exploring","label":"Estoy explorando"}]'::jsonb,
   true, 900)

on conflict (id) do update set
  category   = excluded.category,
  prompt     = excluded.prompt,
  help_text  = excluded.help_text,
  input_type = excluded.input_type,
  options    = excluded.options,
  required   = excluded.required,
  sort_order = excluded.sort_order,
  active     = true;
