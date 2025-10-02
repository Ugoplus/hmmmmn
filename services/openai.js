// services/openai.js - Enhanced version with human-friendly job labels

const { Queue, QueueEvents } = require('bullmq');
const crypto = require('crypto');
const { redis, queueRedis, sessionRedis } = require('../config/redis');
const logger = require('../utils/logger');
const RateLimiter = require('../utils/rateLimiter');

// Enhanced queue configuration for better performance
const openaiQueue = new Queue('openai-tasks', { 
  connection: queueRedis,
  prefix: 'queue:',
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: {
      age: 300,      // Remove completed jobs after 5 minutes
      count: 100,    // Keep max 100 completed jobs
    },
    removeOnFail: {
      age: 1800,     // Remove failed jobs after 30 minutes
      count: 50,     // Keep max 50 failed jobs
    },
    ttl: 30000,      // Job timeout: 30 seconds
  },
});

// Create QueueEvents with separate connection
const queueEvents = new QueueEvents('openai-tasks', { 
  connection: queueRedis,
  prefix: 'queue:'
});
queueEvents.on('ready', () => {
  logger.info('QueueEvents ready for openai-tasks');
});

queueEvents.on('error', (error) => {
  logger.error('QueueEvents error', { error: error.message });
});

class AIService {
  constructor() {
    this.queryCache = new Map();
    this.cacheMaxSize = 2000;
    this.cacheMaxAge = 10 * 60 * 1000;
    
    // Performance metrics (for monitoring)
    this.metrics = {
      cacheHits: 0,
      patternMatches: 0,
      aiCalls: 0,
      totalRequests: 0
    };
    
    // Human-friendly job category labels
    this.jobLabels = {
      'accounting_finance': 'Accounting & Finance',
      'admin_office': 'Administration & Office Support',
      'engineering_technical': 'Developer & Engineering',
      'it_software': 'IT & Software',
      'marketing_sales': 'Sales & Marketing',
      'healthcare_medical': 'Healthcare & Medical',
      'education_training': 'Education & Training',
      'management_executive': 'Management & Executive',
      'human_resources': 'Human Resources',
      'logistics_supply': 'Logistics & Supply Chain',
      'customer_service': 'Customer Service',
      'legal_compliance': 'Legal & Compliance',
      'media_creative': 'Media & Creative',
      'security_safety': 'Security & Safety',
      'construction_real_estate': 'Construction & Real Estate',
      'manufacturing_production': 'Manufacturing & Production',
      'retail_fashion': 'Retail & Fashion',
      'transport_driving': 'Transport & Driving',
      'other_general': 'General Jobs'
    };

    // Friendly search phrases (randomized)
    this.searchPhrases = [
      'Looking for {jobType} opportunities in {location}...',
      'Searching {jobType} roles in {location}...',
      'Finding the latest {jobType} jobs in {location}...',
      'Checking {jobType} positions in {location}...',
      'Discovering {jobType} openings in {location}...',
    ];

    // Keywords for better job detection
  // Complete jobKeywords mapping for all 19 categories
this.jobKeywords = {
  // 1. IT & Software Development
  'software developer': 'it_software',
  'web developer': 'it_software', 
  'app developer': 'it_software',
  'mobile developer': 'it_software',
  'frontend developer': 'it_software',
  'backend developer': 'it_software',
  'fullstack developer': 'it_software',
  'full stack developer': 'it_software',
  'software engineer': 'it_software',
  'web engineer': 'it_software',
  'frontend engineer': 'it_software',
  'backend engineer': 'it_software',
  'devops engineer': 'it_software',
  'mobile engineer': 'it_software',
  'developer': 'it_software',
  'programmer': 'it_software',
  'coding': 'it_software',
  'programming': 'it_software',
  'software': 'it_software',
  'web design': 'it_software',
  'website': 'it_software',
  'database': 'it_software',
  'system administrator': 'it_software',
  'network administrator': 'it_software',
  'it support': 'it_software',
  'technical support': 'it_software',
  'cyber security': 'it_software',
  'data analyst': 'it_software',
  'business analyst': 'it_software',
  
  // 2. Accounting & Finance
  'accounting': 'accounting_finance',
  'accountant': 'accounting_finance',
  'chartered accountant': 'accounting_finance',
  'management accountant': 'accounting_finance',
  'cost accountant': 'accounting_finance',
  'senior accountant': 'accounting_finance',
  'trainee accountant': 'accounting_finance',
  'factory accountant': 'accounting_finance',
  'finance': 'accounting_finance',
  'financial': 'accounting_finance',
  'financial analyst': 'accounting_finance',
  'financial controller': 'accounting_finance',
  'finance manager': 'accounting_finance',
  'finance accounts manager': 'accounting_finance',
  'bookkeeper': 'accounting_finance',
  'bookkeeping': 'accounting_finance',
  'accounts': 'accounting_finance',
  'accounts manager': 'accounting_finance',
  'accounts clerk': 'accounting_finance',
  'accounts payable': 'accounting_finance',
  'accounts receivable': 'accounting_finance',
  'audit': 'accounting_finance',
  'auditing': 'accounting_finance',
  'auditor': 'accounting_finance',
  'internal auditor': 'accounting_finance',
  'treasury': 'accounting_finance',
  'budget': 'accounting_finance',
  'budget analyst': 'accounting_finance',
  'tax': 'accounting_finance',
  'tax assistant': 'accounting_finance',
  'cashier': 'accounting_finance',
  'teller': 'accounting_finance',
  'banker': 'accounting_finance',
  'banking': 'accounting_finance',
  'relationship manager': 'accounting_finance',
  'key account manager': 'accounting_finance',
  'account officer': 'accounting_finance',
  'internal control officer': 'accounting_finance',
  
  // 3. Sales & Marketing
  'sales': 'marketing_sales',
  'selling': 'marketing_sales',
  'sales marketing': 'marketing_sales',
  'marketing sales': 'marketing_sales',
  'sales & marketing': 'marketing_sales',
  'sales and marketing': 'marketing_sales',
  'marketing': 'marketing_sales',
  'marketing manager': 'marketing_sales',
  'brand manager': 'marketing_sales',
  'product manager': 'marketing_sales',
  'marketing executive': 'marketing_sales',
  'marketing coordinator': 'marketing_sales',
  'digital marketing': 'marketing_sales',
  'social media manager': 'marketing_sales',
  'social media handler': 'marketing_sales',
  'social media': 'marketing_sales',
  'content marketing': 'marketing_sales',
  'business development': 'marketing_sales',
  'business developer': 'marketing_sales',
  'sales representative': 'marketing_sales',
  'sales rep': 'marketing_sales',
  'sales executive': 'marketing_sales',
  'sales officer': 'marketing_sales',
  'customer sales executive': 'marketing_sales',
  'territory manager': 'marketing_sales',
  'area sales manager': 'marketing_sales',
  'regional sales manager': 'marketing_sales',
  'account manager': 'marketing_sales',
  'client manager': 'marketing_sales',
  'advertisement': 'marketing_sales',
  'promotion': 'marketing_sales',
  'brand': 'marketing_sales',
  'market research': 'marketing_sales',
  
  // 4. Healthcare & Medical
  'medical': 'healthcare_medical',
  'healthcare': 'healthcare_medical',
  'health': 'healthcare_medical',
  'medical doctor': 'healthcare_medical',
  'medical officer': 'healthcare_medical',
  'doctor': 'healthcare_medical',
  'physician': 'healthcare_medical',
  'consultant': 'healthcare_medical',
  'nurse': 'healthcare_medical',
  'nursing': 'healthcare_medical',
  'registered nurse': 'healthcare_medical',
  'nurse practitioner': 'healthcare_medical',
  'nurse midwife': 'healthcare_medical',
  'industrial nurse': 'healthcare_medical',
  'epi nurse': 'healthcare_medical',
  'nursing manager': 'healthcare_medical',
  'caregiver': 'healthcare_medical',
  'pharmacist': 'healthcare_medical',
  'pharmacy': 'healthcare_medical',
  'production pharmacist': 'healthcare_medical',
  'dentist': 'healthcare_medical',
  'dental': 'healthcare_medical',
  'laboratory': 'healthcare_medical',
  'laboratory scientist': 'healthcare_medical',
  'medical laboratory scientist': 'healthcare_medical',
  'medical laboratory technician': 'healthcare_medical',
  'laboratory technician': 'healthcare_medical',
  'lab technician': 'healthcare_medical',
  'lab analyst': 'healthcare_medical',
  'microbiologist': 'healthcare_medical',
  'chemist': 'healthcare_medical',
  'radiographer': 'healthcare_medical',
  'medical physicist': 'healthcare_medical',
  'radiation therapist': 'healthcare_medical',
  'radiation oncologist': 'healthcare_medical',
  'oncology officer': 'healthcare_medical',
  'clinical': 'healthcare_medical',
  'clinical officer': 'healthcare_medical',
  'clinical administrator': 'healthcare_medical',
  'healthcare worker': 'healthcare_medical',
  'medical assistant': 'healthcare_medical',
  'medical receptionist': 'healthcare_medical',
  'medical data processor': 'healthcare_medical',
  'health officer': 'healthcare_medical',
  'health promoter': 'healthcare_medical',
  'food technologist': 'healthcare_medical',
  
  // 5. Engineering & Technical
  'engineer': 'engineering_technical',
  'engineering': 'engineering_technical',
  'civil engineer': 'engineering_technical',
  'mechanical engineer': 'engineering_technical',
  'electrical engineer': 'engineering_technical',
  'chemical engineer': 'engineering_technical',
  'structural engineer': 'engineering_technical',
  'project engineer': 'engineering_technical',
  'site engineer': 'engineering_technical',
  'process engineer': 'engineering_technical',
  'quality engineer': 'engineering_technical',
  'maintenance engineer': 'engineering_technical',
  'production engineer': 'engineering_technical',
  'design engineer': 'engineering_technical',
  'building engineer': 'engineering_technical',
  'biomedical engineer': 'engineering_technical',
  'manufacturing engineer': 'engineering_technical',
  'technician': 'engineering_technical',
  'technical': 'engineering_technical',
  'mechanical technician': 'engineering_technical',
  'electrical technician': 'engineering_technical',
  'maintenance technician': 'engineering_technical',
  'technical operator': 'engineering_technical',
  'technical training instructor': 'engineering_technical',
  'maintenance': 'engineering_technical',
  'maintenance officer': 'engineering_technical',
  'maintenance manager': 'engineering_technical',
  'maintenance planner': 'engineering_technical',
  
  // 6. Education & Training  
  'teacher': 'education_training',
  'teaching': 'education_training',
  'tutor': 'education_training',
  'instructor': 'education_training',
  'lecturer': 'education_training',
  'professor': 'education_training',
  'education': 'education_training',
  'educational': 'education_training',
  'training': 'education_training',
  'trainer': 'education_training',
  'montessori teacher': 'education_training',
  'french teacher': 'education_training',
  'music teacher': 'education_training',
  'biology teacher': 'education_training',
  'english teacher': 'education_training',
  'secondary school teacher': 'education_training',
  'primary school teacher': 'education_training',
  'university lecturer': 'education_training',
  'training coordinator': 'education_training',
  'curriculum developer': 'education_training',
  'education officer': 'education_training',
  'yoga instructor': 'education_training',
  'coach': 'education_training',
  'academic': 'education_training',
  
  // 7. Administration & Office
  'admin': 'admin_office',
  'administration': 'admin_office',
  'administrative': 'admin_office',
  'administrator': 'admin_office',
  'administrative assistant': 'admin_office',
  'admin assistant': 'admin_office',
  'office assistant': 'admin_office',
  'executive assistant': 'admin_office',
  'personal assistant': 'admin_office',
  'clerical assistant': 'admin_office',
  'secretary': 'admin_office',
  'legal secretary': 'admin_office',
  'receptionist': 'admin_office',
  'front desk': 'admin_office',
  'front desk executive': 'admin_office',
  'front office executive': 'admin_office',
  'admin officer': 'admin_office',
  'administrative officer': 'admin_office',
  'office manager': 'admin_office',
  'clerk': 'admin_office',
  'clerical': 'admin_office',
  'data entry': 'admin_office',
  'data entry assistant': 'admin_office',
  'filing': 'admin_office',
  'documentation': 'admin_office',
  
  // 8. Management & Executive
  'manager': 'management_executive',
  'management': 'management_executive',
  'supervisor': 'management_executive',
  'director': 'management_executive',
  'executive': 'management_executive',
  'coordinator': 'management_executive',
  'general manager': 'management_executive',
  'operations manager': 'management_executive',
  'branch manager': 'management_executive',
  'area manager': 'management_executive',
  'regional manager': 'management_executive',
  'project manager': 'management_executive',
  'program manager': 'management_executive',
  'team lead': 'management_executive',
  'team leader': 'management_executive',
  'chief executive': 'management_executive',
  'managing director': 'management_executive',
  'country director': 'management_executive',
  'department head': 'management_executive',
  'head': 'management_executive',
  'senior': 'management_executive',
  'lead': 'management_executive',
  'supervisor': 'management_executive',
  'superintendent': 'management_executive',
  'foreman': 'management_executive',
  'site supervisor': 'management_executive',
  'construction supervisor': 'management_executive',
  'production supervisor': 'management_executive',
  'logistics supervisor': 'management_executive',
  'transport supervisor': 'management_executive',
  
  // 9. Human Resources
  'human resources': 'human_resources',
  'human resource': 'human_resources',
  'hr': 'human_resources',
  'hr manager': 'human_resources',
  'hr officer': 'human_resources',
  'hr assistant': 'human_resources',
  'hr admin manager': 'human_resources',
  'hr associates': 'human_resources',
  'hr business partner': 'human_resources',
  'hrbp': 'human_resources',
  'human resources intern': 'human_resources',
  'recruitment': 'human_resources',
  'recruiter': 'human_resources',
  'recruitment officer': 'human_resources',
  'diversity recruiter': 'human_resources',
  'talent acquisition': 'human_resources',
  'talent': 'human_resources',
  'payroll': 'human_resources',
  'payroll officer': 'human_resources',
  'payroll specialist': 'human_resources',
  'personnel': 'human_resources',
  'staffing': 'human_resources',
  'employee relations': 'human_resources',
  
  // 10. Customer Service
  'customer service': 'customer_service',
  'customer support': 'customer_service',
  'client service': 'customer_service',
  'customer care': 'customer_service',
  'customer service executive': 'customer_service',
  'customer service representative': 'customer_service',
  'customer care officer': 'customer_service',
  'call center': 'customer_service',
  'call center agent': 'customer_service',
  'help desk': 'customer_service',
  'support agent': 'customer_service',
  'representative': 'customer_service',
  'agent': 'customer_service',
  'support': 'customer_service',
  
  // 11. Legal & Compliance
  'legal': 'legal_compliance',
  'lawyer': 'legal_compliance',
  'attorney': 'legal_compliance',
  'barrister': 'legal_compliance',
  'solicitor': 'legal_compliance',
  'paralegal': 'legal_compliance',
  'legal officer': 'legal_compliance',
  'legal manager': 'legal_compliance',
  'legal secretary': 'legal_compliance',
  'legal advisor': 'legal_compliance',
  'legal counsel': 'legal_compliance',
  'compliance': 'legal_compliance',
  'compliance officer': 'legal_compliance',
  'regulatory': 'legal_compliance',
  'regulatory officer': 'legal_compliance',
  'contract': 'legal_compliance',
  'contract manager': 'legal_compliance',
  'litigation': 'legal_compliance',
  'corporate law': 'legal_compliance',
  
  // 12. Media & Creative
  'designer': 'media_creative',
  'design': 'media_creative',
  'graphic designer': 'media_creative',
  'graphics designer': 'media_creative',
  'web designer': 'media_creative',
  'ui designer': 'media_creative',
  'ux designer': 'media_creative',
  'brand designer': 'media_creative',
  'content creator': 'media_creative',
  'content writer': 'media_creative',
  'content manager': 'media_creative',
  'content': 'media_creative',
  'copywriter': 'media_creative',
  'writer': 'media_creative',
  'editor': 'media_creative',
  'video editor': 'media_creative',
  'video producer': 'media_creative',
  'videographer': 'media_creative',
  'photographer': 'media_creative',
  'photography': 'media_creative',
  'journalist': 'media_creative',
  'creative director': 'media_creative',
  'creative': 'media_creative',
  'artist': 'media_creative',
  'media': 'media_creative',
  'social media manager': 'media_creative',
  'social media handler': 'media_creative',
  'social media': 'media_creative',
  'digital marketing': 'media_creative',
  
  // 13. Logistics & Supply Chain
  'logistics': 'logistics_supply',
  'supply chain': 'logistics_supply',
  'logistics officer': 'logistics_supply',
  'logistics supervisor': 'logistics_supply',
  'warehouse': 'logistics_supply',
  'warehouse manager': 'logistics_supply',
  'warehouse assistant': 'logistics_supply',
  'warehouse clerk': 'logistics_supply',
  'warehouse incharge': 'logistics_supply',
  'inventory': 'logistics_supply',
  'inventory manager': 'logistics_supply',
  'store officer': 'logistics_supply',
  'store manager': 'logistics_supply',
  'store assistant': 'logistics_supply',
  'storekeeper': 'logistics_supply',
  'procurement': 'logistics_supply',
  'procurement officer': 'logistics_supply',
  'procurement manager': 'logistics_supply',
  'purchasing': 'logistics_supply',
  'purchasing officer': 'logistics_supply',
  'purchasing manager': 'logistics_supply',
  'purchase manager': 'logistics_supply',
  'supply': 'logistics_supply',
  'distribution': 'logistics_supply',
  'transport officer': 'logistics_supply',
  'transport supervisor': 'logistics_supply',
  'shipping': 'logistics_supply',
  'fleet': 'logistics_supply',
  'operations': 'logistics_supply',
  
  // 14. Security & Safety
  'security': 'security_safety',
  'safety': 'security_safety',
  'security officer': 'security_safety',
  'security guard': 'security_safety',
  'guard': 'security_safety',
  'safety officer': 'security_safety',
  'hse officer': 'security_safety',
  'health safety environment': 'security_safety',
  'environment health safety': 'security_safety',
  'safety security health': 'security_safety',
  'hse coordinator': 'security_safety',
  'hse graduate trainee': 'security_safety',
  'safety coordinator': 'security_safety',
  'security coordinator': 'security_safety',
  'ehs officer': 'security_safety',
  'mine safety officer': 'security_safety',
  'health safety': 'security_safety',
  'environment safety': 'security_safety',
  'surveillance': 'security_safety',
  'protection': 'security_safety',
  'risk': 'security_safety',
  
  // 15. Construction & Real Estate
  'construction': 'construction_real_estate',
  'builder': 'construction_real_estate',
  'construction manager': 'construction_real_estate',
  'construction supervisor': 'construction_real_estate',
  'site manager': 'construction_real_estate',
  'site supervisor': 'construction_real_estate',
  'construction foreman': 'construction_real_estate',
  'foreman': 'construction_real_estate',
  'site foreman': 'construction_real_estate',
  'project manager construction': 'construction_real_estate',
  'architect': 'construction_real_estate',
  'quantity surveyor': 'construction_real_estate',
  'land surveyor': 'construction_real_estate',
  'surveyor': 'construction_real_estate',
  'building': 'construction_real_estate',
  'building engineer': 'construction_real_estate',
  'real estate': 'construction_real_estate',
  'property': 'construction_real_estate',
  'property manager': 'construction_real_estate',
  'realtor': 'construction_real_estate',
  'estate agent': 'construction_real_estate',
  
  // 16. Manufacturing & Production
  'manufacturing': 'manufacturing_production',
  'production': 'manufacturing_production',
  'factory': 'manufacturing_production',
  'manufacturing engineer': 'manufacturing_production',
  'production manager': 'manufacturing_production',
  'production superintendent': 'manufacturing_production',
  'factory manager': 'manufacturing_production',
  'production supervisor': 'manufacturing_production',
  'quality control': 'manufacturing_production',
  'quality assurance': 'manufacturing_production',
  'quality assurance manager': 'manufacturing_production',
  'lab analyst': 'manufacturing_production',
  'technical operator': 'manufacturing_production',
  'factory accountant': 'manufacturing_production',
  'feed miller': 'manufacturing_production',
  'forklift operator': 'manufacturing_production',
  'assembly': 'manufacturing_production',
  'operator': 'manufacturing_production',
  'processing': 'manufacturing_production',
  'plant': 'manufacturing_production',
  
  // 17. Transport & Driving
  'driver': 'transport_driving',
  'driving': 'transport_driving',
  'truck driver': 'transport_driving',
  'delivery driver': 'transport_driving',
  'company driver': 'transport_driving',
  'mini truck driver': 'transport_driving',
  'pool car driver': 'transport_driving',
  'transport': 'transport_driving',
  'transport officer': 'transport_driving',
  'logistics driver': 'transport_driving',
  'delivery': 'transport_driving',
  'courier': 'transport_driving',
  'dispatch': 'transport_driving',
  'baggage handler': 'transport_driving',
  'crew scheduling officer': 'transport_driving',
  
  // 18. Retail & Fashion
  'retail': 'retail_fashion',
  'retail manager': 'retail_fashion',
  'store': 'retail_fashion',
  'store manager': 'retail_fashion',
  'shop': 'retail_fashion',
  'sales assistant': 'retail_fashion',
  'cashier': 'retail_fashion',
  'merchandising': 'retail_fashion',
  'merchandiser': 'retail_fashion',
  'fashion': 'retail_fashion',
  'fashion designer': 'retail_fashion',
  'buyer': 'retail_fashion',
  'visual': 'retail_fashion',
  
  // 19. General Jobs
  'general': 'other_general',
  'officer': 'other_general',
  'specialist': 'other_general',
  'associate': 'other_general',
  'coordinator': 'other_general',
  'intern': 'other_general',
  'trainee': 'other_general',
  'graduate': 'other_general',
  'entry level': 'other_general',
  'entry': 'other_general',
  'junior': 'other_general',
  'assistant': 'other_general',
  'helper': 'other_general',
  'worker': 'other_general',
  'volunteer': 'other_general',
  'agronomist': 'other_general',
  'field enumerator': 'other_general', 
  'data enumerator': 'other_general',
  'research assistant': 'other_general',
  'documentary researcher': 'other_general',
  'nanny': 'other_general',
  'sous chef': 'other_general',
  'pastor': 'other_general'
};
    
    // Your existing jobTypes object (keep for database searches)
    this.jobTypes = {
      'accounting_finance': ['account', 'accountant', 'accounting', 'accounts', 'acquisition', 'actuarial', 'admin', 'administrator', 'agents', 'airlines', 'akwa', 'annona', 'ascentech', 'assistant', 'associate', 'audit', 'auditing', 'bank', 'banking', 'based', 'bauchi', 'best', 'blending', 'bookkeep', 'bookkeeper', 'budget', 'bureau', 'cashier', 'chartered', 'clay', 'clerk', 'commercial', 'commission', 'company', 'compliance', 'consultancy', 'control', 'corporation', 'crc', 'credit', 'crescita', 'database', 'development', 'distribution', 'dufil', 'eastern', 'eedc', 'electricity', 'energy', 'enugu', 'executive', 'factory', 'feed', 'felton', 'fertilizer', 'fesl', 'finance', 'financial', 'flour', 'foods', 'frontieres', 'funds', 'grains', 'head', 'hello', 'ibom', 'imtt', 'initiative', 'institutional', 'insurance', 'internal', 'inventory', 'investment', 'ire', 'key', 'labdi', 'life', 'limited', 'loan', 'manager', 'medecins', 'mills', 'mobilization', 'msf', 'nesco', 'nigeria', 'nigerian', 'officer', 'payable', 'payroll', 'plant', 'plc', 'premier', 'prima', 'products', 'project', 'promasidor', 'receivable', 'relationship', 'remote', 'retail', 'rfs', 'rosabon', 'sans', 'senior', 'services', 'sme', 'solutions', 'sterling', 'supply', 'taimaka', 'tax', 'traveldeer', 'treasury', 'united', 'vitafoam'],
      'admin_office': ['abia', 'achieving', 'action', 'adamawa', 'admin', 'administration', 'administrative', 'administrator', 'advocacy', 'africa', 'agribusiness', 'agriculture', 'ahni', 'aide', 'airlines', 'analyst', 'ascentech', 'assistant', 'assistants', 'associate', 'background', 'bank', 'base', 'best', 'beverages', 'biotechnology', 'branch', 'bristow', 'business', 'care', 'casfod', 'cash', 'catalyst', 'chicmicro', 'children', 'church', 'city', 'clerk', 'climate', 'clinical', 'collector', 'committed', 'community', 'company', 'consortium', 'construction', 'consultancy', 'consultant', 'consulting', 'control', 'cooperazione', 'coopi', 'coordinator', 'copyright', 'corrugation', 'council', 'craneburg', 'crescita', 'crew', 'ctg', 'cuddle', 'dangote', 'data', 'data entry', 'des', 'development', 'displaced', 'documentation', 'dreamworks', 'eastern', 'ebonyi', 'ecews', 'ecw', 'education', 'ehs', 'emerald', 'emergency', 'employee', 'empowerment', 'energy', 'engagement', 'entry', 'environment', 'evaluation', 'excellence', 'face', 'facility', 'family', 'feed', 'fellowship', 'fer', 'fever', 'fidelity', 'field', 'filing', 'finance', 'finpact', 'fleet', 'flour', 'food', 'forward', 'foundation', 'frontieres', 'fund', 'fze', 'ganfeng', 'general', 'getpayed', 'global', 'gongola', 'good', 'goonite', 'group', 'growth', 'hands', 'health', 'healthcare', 'helicopters', 'help', 'helpers', 'hiv', 'hommes', 'human', 'hygiene', 'icla', 'iec', 'incorporated', 'industries', 'industry', 'informatics', 'information', 'initiative', 'internal', 'international', 'internationale', 'internazionale', 'iom', 'jhpiego', 'kedi', 'labdi', 'lassa', 'leprosy', 'lhi', 'liaison', 'licensing', 'life', 'limited', 'lithium', 'livelihood', 'living', 'logistics', 'maintenance', 'malaria', 'malnutrition', 'management', 'manager', 'managers', 'marketing', 'materials', 'matter', 'mcsn', 'meal', 'mechanized', 'medecins', 'migration', 'mills', 'mine', 'minim', 'mission', 'mitigation', 'moniepoint', 'monitoring', 'montego', 'msf', 'music', 'musical', 'national', 'nations', 'nepwhan', 'network', 'new', 'nfdp', 'niger', 'nigeria', 'northwest', 'norwegian', 'nrc', 'nuru', 'nutrition', 'office', 'officer', 'officers', 'offices', 'oncology', 'ondo', 'operations', 'operator', 'oppo', 'optimus', 'organization', 'organizational', 'outreach', 'packaging', 'pam', 'path', 'pathfinder', 'pension', 'people', 'persons', 'plastic', 'plc', 'polaris', 'population', 'poverty', 'premier', 'premiere', 'procurement', 'product', 'program', 'programme', 'project', 'promoter', 'protection', 'public', 'pui', 'purchasing', 'quantum', 'receptionist', 'refugee', 'regional', 'reliable', 'research', 'resident', 'resource', 'safety', 'sales', 'sans', 'save', 'scheduling', 'scheme', 'secretary', 'section', 'security', 'self', 'senior', 'services', 'sfhf', 'sgbv', 'shulifang', 'sims', 'society', 'solutions', 'state', 'steel', 'store', 'support', 'sustainable', 'swoden', 'tdh', 'tearfund', 'technical', 'technology', 'terre', 'tlmn', 'tonye', 'too', 'transport', 'tyeeli', 'unfpa', 'unicef', 'union', 'unique', 'united', 'unity', 'upstream', 'urgence', 'vine', 'warehouse', 'wash', 'welfare', 'wfp', 'wima', 'women', 'world'],
      'engineering_technical': ['abia', 'abnl', 'africa', 'airways', 'apm', 'apple', 'architect', 'assurance', 'automation', 'biomedical', 'blaster', 'board', 'breweries', 'briscoe', 'cdcfib', 'chemical', 'civil', 'cloud', 'cng', 'coating', 'commission', 'commissioning', 'control', 'correctional', 'cost', 'crescita', 'dangote', 'data', 'defence', 'delta', 'devops', 'electrical', 'electrician', 'elper', 'energy', 'engineer', 'engineering', 'engineers', 'facilities', 'fire', 'food', 'foreman', 'green', 'group', 'hexagon', 'immigration', 'inspector', 'installation', 'instrument', 'international', 'lafarge', 'lagos', 'lead', 'limited', 'line', 'machinery', 'machines', 'maintenance', 'marine', 'mechanical', 'mhc', 'mhe', 'nigeria', 'oilfield', 'operator', 'packaging', 'pears', 'petroleum', 'planner', 'plant', 'plc', 'power', 'pre', 'process', 'quality', 'recruitment', 'repair', 'sales', 'scheduler', 'seplat', 'service', 'services', 'software', 'solutions', 'state', 'supervisor', 'technical', 'technician', 'terminals', 'tester', 'trainee', 'treatment', 'vacancies', 'wartsila', 'water'],
      'it_software': ['activity', 'alfred', 'app', 'apple', 'apprenticeship', 'area', 'associates', 'bank', 'cloud', 'coding', 'crescita', 'cyber', 'database', 'developer', 'embedded', 'energy', 'engineer', 'esosa', 'food', 'full', 'gen', 'innovations', 'international', 'kite', 'limited', 'livelihood', 'manager', 'marketer', 'mobile', 'network', 'nigeria', 'pears', 'plc', 'program', 'programmer', 'programming', 'representatives', 'sales', 'sap', 'security', 'senior', 'software', 'solidarites', 'solutions', 'stack', 'sterling', 'storekeeper', 'system', 'systems', 'victoria', 'vivo', 'web'],
      'marketing_sales': ['abo', 'advertising', 'affiliate', 'africa', 'agent', 'annona', 'area', 'ascentech', 'associate', 'bank', 'benckiser', 'bess', 'bottling', 'brand', 'branding', 'breweries', 'business', 'campaign', 'champions', 'client', 'cocoa', 'commerce', 'company', 'consulting', 'corporate', 'crescita', 'customer', 'dairy', 'delegation', 'development', 'dicalo', 'diesel', 'digital', 'direct', 'divisional', 'ekini', 'end', 'entrepreneurship', 'executive', 'food', 'foods', 'foundation', 'funnel', 'gas', 'gensets', 'genuine', 'german', 'goldfish', 'grains', 'grants', 'group', 'growth', 'hacker', 'head', 'high', 'hrbp', 'human', 'industries', 'industry', 'integrated', 'international', 'interswitch', 'kickstart', 'limited', 'manager', 'managers', 'manufacturing', 'marketing', 'medical', 'medium', 'mentorship', 'milk', 'million', 'mills', 'mol', 'naira', 'nigeria', 'nigerians', 'north', 'palmpay', 'partner', 'payments', 'plc', 'power', 'processing', 'procurement', 'programme', 'promotion', 'providus', 'reckitt', 'red', 'regional', 'relationship', 'representatives', 'resourse', 'rsin', 'sales', 'salesforce', 'septagus', 'services', 'seven', 'snacks', 'social media', 'solutions', 'sonia', 'star', 'sterling', 'supervisor', 'supervisors', 'territory', 'tide', 'training', 'tse', 'tsm', 'tulip', 'uac', 'vitafoam', 'wellcome', 'west', 'white', 'young', 'zest', 'zhongyuan'],
      'healthcare_medical': ['action', 'alima', 'alliance', 'archivist', 'associates', 'avatar', 'biomedical', 'center', 'chemist', 'children', 'clinical', 'community', 'company', 'corporation', 'data', 'deputy', 'diagnostic', 'doctor', 'donkor', 'electricity', 'energy', 'entry', 'environment', 'fever', 'first', 'frontieres', 'head', 'health', 'hospital', 'hospitality', 'international', 'internationale', 'jda', 'jerry', 'jhpiego', 'jigawa', 'laboratory', 'lamb', 'lassa', 'lead', 'level', 'limited', 'manager', 'materials', 'medecins', 'medical', 'microbiologist', 'ministry', 'msf', 'nesco', 'new', 'nigeria', 'nigerian', 'nurse', 'observators', 'officer', 'pharmaceutical', 'pharmacist', 'pharmacy', 'physician', 'plc', 'premiere', 'processor', 'production', 'program', 'project', 'pui', 'qhse', 'quality', 'records', 'research', 'resident', 'rivers', 'ruth', 'safety', 'sans', 'scientist', 'she', 'site', 'state', 'supervisors', 'supply', 'technician', 'therapy', 'unilever', 'urgence', 'worker'],
      'education_training': ['academic', 'admiralty', 'ado', 'adorable', 'advertisement', 'alex', 'alike', 'benin', 'biology', 'blue', 'book', 'borderlesshr', 'british', 'calabar', 'clark', 'college', 'commission', 'construction', 'curriculum', 'development', 'diageo', 'dutse', 'ecu', 'education', 'edwin', 'ekiti', 'ekwueme', 'english', 'european', 'external', 'federal', 'frontieres', 'fud', 'funai', 'graduates', 'institute', 'instructor', 'invitation', 'isouchi', 'kings', 'learning', 'life', 'management', 'manager', 'massive', 'medecins', 'month', 'msf', 'national', 'ndogo', 'ndufu', 'nictm', 'nigeria', 'nigerians', 'non', 'paid', 'polytechnic', 'positions', 'program', 'recruitment', 'sans', 'school', 'search', 'staff', 'teacher', 'technology', 'traineeship', 'training', 'tutor', 'university', 'uromi', 'vacancies', 'worldwide', 'young'],
      'management_executive': ['action', 'advisory', 'africaplan', 'against', 'airlines', 'aluminium', 'amo', 'anheuser', 'annona', 'apartment', 'assistant', 'assurance', 'bank', 'bernie', 'best', 'beverages', 'bogo', 'bottling', 'branch', 'breweries', 'busch', 'byng', 'ceo', 'cfo', 'chain', 'chief', 'child', 'commerce', 'commercial', 'communication', 'company', 'conservation', 'construction', 'consulting', 'coo', 'cooperazione', 'coopi', 'country', 'cradi', 'crescita', 'crest', 'data', 'delegation', 'deputy', 'development', 'dicalo', 'diligence', 'director', 'displaced', 'district', 'east', 'empowerment', 'engine', 'ernst', 'evaluation', 'executive', 'executives', 'experiential', 'field', 'fleet', 'foundation', 'gas', 'german', 'global', 'goalprime', 'gpon', 'grains', 'group', 'head', 'health', 'holdings', 'housekeeper', 'human', 'hunger', 'hygiene', 'inbev', 'incorporated', 'industries', 'industry', 'initiative', 'institute', 'international', 'internationale', 'internazionale', 'labdi', 'lead', 'leading', 'life', 'limited', 'lington', 'management', 'manager', 'markets', 'meal', 'mills', 'minim', 'moniepoint', 'monitoring', 'new', 'nfdp', 'nigeria', 'nosagie', 'nursing', 'nutrition', 'officer', 'oil', 'operation', 'operations', 'optimization', 'optimus', 'organization', 'packaging', 'persons', 'philanthropies', 'plc', 'portfolio', 'premiere', 'principal', 'procurement', 'production', 'program', 'programme', 'programs', 'project', 'projects', 'property', 'protection', 'pui', 'purchase', 'quality', 'redeemer', 'research', 'resource', 'retail', 'rhv', 'sanitation', 'search', 'senior', 'seo', 'service', 'seven', 'sigma', 'site', 'society', 'solidarites', 'solutions', 'station', 'stellar', 'storekeeper', 'sundry', 'supervisor', 'supply', 'swoden', 'tantacom', 'technology', 'tellers', 'thriving', 'tonye', 'trainee', 'transaction', 'united', 'urgence', 'vagan', 'village', 'voice', 'wash', 'water', 'wcs', 'wildlife', 'woman', 'women', 'young', 'zumera'],
      'human_resources': ['air', 'assistant', 'associates', 'bank', 'benefits', 'company', 'conservation', 'dssc', 'economy', 'employee', 'energy', 'fellowship', 'force', 'fully', 'funded', 'government', 'hr', 'human', 'human resources', 'indigenous', 'industrial', 'industry', 'intern', 'internationale', 'internships', 'japan', 'limited', 'logistics', 'manager', 'meti', 'ministry', 'nations', 'new', 'nigerian', 'ohchr', 'ongoing', 'payroll', 'personnel', 'premiere', 'programme', 'pui', 'recruiter', 'recruitment', 'relations', 'resources', 'shomas', 'society', 'staffing', 'supply', 'talent', 'tech', 'titan', 'trade', 'training', 'trust', 'tyeeli', 'united', 'urgence', 'wcs', 'wildlife', 'worknigeria'],
      'logistics_supply': ['analyst', 'assistant', 'breweries', 'control', 'controller', 'cussons', 'delivery', 'displaced', 'distribution', 'fleet', 'foundation', 'international', 'inventory', 'limited', 'logistics', 'new', 'nfdp', 'nigeria', 'officer', 'operations', 'persons', 'planner', 'plc', 'procurement', 'purchasing', 'shipping', 'shomas', 'supervisor', 'supply', 'transportation', 'warehouse'],
      'customer_service': ['airlines', 'ascentech', 'bank', 'call center', 'care', 'client service', 'cse', 'customer', 'customer service', 'customer support', 'executive', 'help desk', 'limited', 'logistics', 'myafrimall', 'nigeria', 'officer', 'optimus', 'representatives', 'service', 'services', 'storekeeper', 'support', 'united'],
      'legal_compliance': ['advisor', 'attorney', 'compliance', 'contract', 'contracts', 'corporate law', 'crescita', 'lawyer', 'legal', 'legal counsel', 'litigation', 'regulatory', 'solutions'],
      'media_creative': ['breweries', 'cereals', 'company', 'content', 'creative', 'design', 'designer', 'editor', 'energy', 'exploration', 'foremen', 'gcl', 'grand', 'graphic', 'iconic', 'industries', 'international', 'journalist', 'limited', 'material', 'media', 'oil', 'open', 'photography', 'planner', 'plastic', 'plc', 'product', 'production', 'reliable', 'rigger', 'sap', 'scheduler', 'seepco', 'steel', 'sterling', 'superintendent', 'university', 'video', 'writer'],
      'security_safety': ['breweries', 'controller', 'environment', 'guard', 'international', 'plc', 'protection', 'risk', 'safety', 'security', 'surveillance'],
      'construction_real_estate': ['architect', 'building', 'construction', 'contractor', 'crescita', 'expert', 'link', 'project management', 'property', 'real estate', 'seo', 'solutions', 'surveyor'],
      'manufacturing_production': ['assembly', 'assistant', 'campboss', 'control', 'cussons', 'econation', 'factory', 'feed', 'flour', 'forklift', 'gol', 'grand', 'human', 'industrial', 'industries', 'limited', 'manufacturing', 'mills', 'nigeria', 'oak', 'offshore', 'operator', 'plastic', 'plc', 'premier', 'processing', 'production', 'program', 'quality', 'quality control', 'reliable', 'resource', 'steel', 'supervisor', 'technician', 'trainee', 'turbine', 'whassan'],
      'retail_fashion': ['buyer', 'construczione', 'fashion', 'limited', 'merchandise', 'migliore', 'retail', 'shop', 'store', 'storekeeper', 'tecniche', 'visual'],
      'transport_driving': ['beverages', 'car', 'commissioner', 'company', 'courier', 'delivery', 'dispatch', 'driver', 'emerald', 'food', 'fund', 'high', 'limited', 'logistics', 'mini', 'nations', 'pool', 'population', 'refugees', 'transport', 'truck', 'unfpa', 'unhcr', 'united'],
      'other_general': ['abia', 'afdb', 'africa', 'african', 'agricultural', 'airlines', 'associate', 'baggage', 'bank', 'berger', 'books', 'bottling', 'cbm', 'chevening', 'commission', 'communications', 'company', 'consortium', 'consulting', 'cradi', 'crest', 'data', 'degree', 'delta', 'development', 'diverse', 'documentary', 'emmix', 'energy', 'entry', 'entry level', 'enumerator', 'enumerators', 'evaluation', 'felton', 'fesl', 'field', 'fitters', 'flexfilms', 'fmcg', 'foundation', 'frontieres', 'fully', 'funded', 'general', 'global', 'government', 'governmental', 'gpd', 'graduate', 'graduates', 'group', 'handler', 'havana', 'helen', 'hki', 'hse', 'implementation', 'indigenous', 'institute', 'intern', 'international', 'internationale', 'internship', 'julius', 'keller', 'kimberly', 'lafarge', 'legal', 'level', 'lga', 'limited', 'literacy', 'local', 'malaria', 'master', 'medecins', 'merit', 'microbiologist', 'midwife', 'monitoring', 'msf', 'multiple', 'national', 'nddc', 'niger', 'nigeria', 'nnpc', 'non', 'officer', 'organization', 'peace', 'phlebotomists', 'piecurve', 'placement', 'plc', 'post', 'premiere', 'profit', 'program', 'programme', 'projects', 'psychologist', 'pui', 'qualitative', 'recent', 'research', 'researcher', 'ryan', 'sans', 'scheme', 'scholarship', 'septagus', 'services', 'session', 'seven', 'smartflow', 'social', 'state', 'structural', 'students', 'study', 'sun', 'survey', 'synlab', 'technologies', 'tellers', 'totalenergies', 'trainee', 'tsdp', 'unesco', 'united', 'urgence', 'vacancies', 'various', 'welders', 'worker', 'world'],
    };

    this.locations = {
      // Original major cities
      'lagos': 'Lagos',
      'abuja': 'Abuja',
      'port harcourt': 'Port Harcourt',
      'portharcourt': 'Port Harcourt',
      'remote': 'Remote',
      
      // All 36 Nigerian States
      'abia': 'Abia',
      'adamawa': 'Adamawa', 
      'akwa ibom': 'Akwa Ibom',
      'anambra': 'Anambra',
      'bauchi': 'Bauchi',
      'bayelsa': 'Bayelsa',
      'benue': 'Benue',
      'borno': 'Borno',
      'cross river': 'Cross River',
      'delta': 'Delta',
      'ebonyi': 'Ebonyi',
      'edo': 'Edo',
      'ekiti': 'Ekiti',
      'enugu': 'Enugu',
      'gombe': 'Gombe',
      'imo': 'Imo',
      'jigawa': 'Jigawa',
      'kaduna': 'Kaduna',
      'kano': 'Kano',
      'katsina': 'Katsina',
      'kebbi': 'Kebbi',
      'kogi': 'Kogi',
      'kwara': 'Kwara',
      'niger': 'Niger',
      'ogun': 'Ogun',
      'ondo': 'Ondo',
      'osun': 'Osun',
      'oyo': 'Oyo',
      'plateau': 'Plateau',
      'rivers': 'Rivers',
      'sokoto': 'Sokoto',
      'taraba': 'Taraba',
      'yobe': 'Yobe',
      'zamfara': 'Zamfara',
      
      // FCT
      'fct': 'FCT',
      
      // Major cities for convenience
      'ibadan': 'Oyo',          // Ibadan is in Oyo state
      'jos': 'Plateau',         // Jos is in Plateau state
      'kano city': 'Kano',      // Kano city in Kano state
      'benin': 'Edo',           // Benin City is in Edo state
      'calabar': 'Cross River', // Calabar is in Cross River
      'uyo': 'Akwa Ibom',       // Uyo is in Akwa Ibom
      'warri': 'Delta',         // Warri is in Delta state
      'maiduguri': 'Borno',     // Maiduguri is in Borno
      'ilorin': 'Kwara',        // Ilorin is in Kwara
      'abeokuta': 'Ogun'        // Abeokuta is in Ogun
    };
    
    setInterval(() => this.cleanCache(), 60000);
    setInterval(() => this.logMetrics(), 300000); // Log metrics every 5 minutes
  }

  // Enhanced job detection method
 // Enhanced job detection method with priority-based matching
// Complete job detection method covering all 19 categories systematically
detectJobTypeFromMessage(text) {
  const lowerText = text.toLowerCase();
  
  // Filter out common non-job words that cause false positives
  const filteredText = lowerText.replace(/\b(i|want|to|apply|for|find|looking|search|get|need|job|jobs|work|want|apply)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  
  logger.info('Job detection processing', {
    originalText: text,
    filteredText: filteredText
  });
  
  // PRIORITY LEVEL 1: Multi-word exact phrases (highest priority)
  const exactPhrases = [
    // IT & Software Development
    { phrases: ['software developer', 'web developer', 'app developer', 'mobile developer', 'frontend developer', 'backend developer', 'fullstack developer', 'full stack developer'], category: 'it_software', title: 'developer' },
    { phrases: ['software engineer', 'web engineer', 'frontend engineer', 'backend engineer', 'devops engineer'], category: 'it_software', title: 'software engineer' },
    { phrases: ['it support', 'technical support', 'system administrator', 'network administrator'], category: 'it_software', title: 'IT support' },
    
    // Accounting & Finance  
    { phrases: ['chartered accountant', 'management accountant', 'cost accountant', 'senior accountant'], category: 'accounting_finance', title: 'accountant' },
    { phrases: ['financial analyst', 'financial controller', 'finance manager', 'accounts manager'], category: 'accounting_finance', title: 'finance' },
    { phrases: ['accounts payable', 'accounts receivable', 'accounts clerk'], category: 'accounting_finance', title: 'accounts' },
    
    // Sales & Marketing
    { phrases: ['sales marketing', 'marketing sales', 'sales & marketing', 'sales and marketing'], category: 'marketing_sales', title: 'sales & marketing' },
    { phrases: ['business development', 'account manager', 'relationship manager', 'key account manager'], category: 'marketing_sales', title: 'business development' },
    { phrases: ['sales representative', 'sales rep', 'sales executive', 'sales officer'], category: 'marketing_sales', title: 'sales' },
    { phrases: ['marketing manager', 'brand manager', 'product manager', 'marketing executive'], category: 'marketing_sales', title: 'marketing' },
    { phrases: ['digital marketing', 'social media manager', 'content marketing', 'marketing coordinator'], category: 'marketing_sales', title: 'digital marketing' },
    
    // Healthcare & Medical
    { phrases: ['medical doctor', 'medical officer', 'registered nurse', 'nurse practitioner'], category: 'healthcare_medical', title: 'medical' },
    { phrases: ['medical laboratory', 'laboratory scientist', 'laboratory technician', 'lab technician'], category: 'healthcare_medical', title: 'laboratory' },
    { phrases: ['clinical officer', 'healthcare worker', 'medical assistant'], category: 'healthcare_medical', title: 'healthcare' },
    
    // Engineering & Technical
    { phrases: ['civil engineer', 'mechanical engineer', 'electrical engineer', 'chemical engineer'], category: 'engineering_technical', title: 'engineer' },
    { phrases: ['project engineer', 'site engineer', 'process engineer', 'quality engineer'], category: 'engineering_technical', title: 'engineer' },
    { phrases: ['maintenance engineer', 'production engineer', 'design engineer'], category: 'engineering_technical', title: 'engineer' },
    
    // Education & Training
    { phrases: ['secondary school teacher', 'primary school teacher', 'university lecturer'], category: 'education_training', title: 'teacher' },
    { phrases: ['training coordinator', 'curriculum developer', 'education officer'], category: 'education_training', title: 'education' },
    
    // Administration & Office
    { phrases: ['administrative assistant', 'executive assistant', 'personal assistant', 'office assistant'], category: 'admin_office', title: 'assistant' },
    { phrases: ['office manager', 'administrative officer', 'admin officer'], category: 'admin_office', title: 'administration' },
    { phrases: ['data entry', 'data entry clerk', 'data processor'], category: 'admin_office', title: 'data entry' },
    
    // Management & Executive
    { phrases: ['general manager', 'operations manager', 'branch manager', 'area manager'], category: 'management_executive', title: 'manager' },
    { phrases: ['project manager', 'program manager', 'team lead', 'team leader'], category: 'management_executive', title: 'manager' },
    { phrases: ['chief executive', 'managing director', 'country director'], category: 'management_executive', title: 'executive' },
    
    // Human Resources
    { phrases: ['human resources', 'hr manager', 'hr officer', 'hr assistant'], category: 'human_resources', title: 'human resources' },
    { phrases: ['recruitment officer', 'talent acquisition', 'payroll officer'], category: 'human_resources', title: 'HR' },
    
    // Customer Service
    { phrases: ['customer service', 'customer support', 'client service', 'customer care'], category: 'customer_service', title: 'customer service' },
    { phrases: ['call center', 'help desk', 'support agent'], category: 'customer_service', title: 'customer support' },
    
    // Legal & Compliance
    { phrases: ['legal officer', 'legal counsel', 'legal advisor', 'compliance officer'], category: 'legal_compliance', title: 'legal' },
    { phrases: ['contract manager', 'regulatory officer'], category: 'legal_compliance', title: 'compliance' },
    
    // Media & Creative
    { phrases: ['graphic designer', 'web designer', 'ui designer', 'ux designer'], category: 'media_creative', title: 'designer' },
    { phrases: ['content creator', 'content writer', 'copywriter'], category: 'media_creative', title: 'content' },
    { phrases: ['video editor', 'social media', 'brand designer'], category: 'media_creative', title: 'creative' },
    
    // Logistics & Supply Chain
    { phrases: ['supply chain', 'logistics officer', 'warehouse manager', 'inventory manager'], category: 'logistics_supply', title: 'logistics' },
    { phrases: ['procurement officer', 'purchasing officer', 'store keeper'], category: 'logistics_supply', title: 'procurement' },
    
    // Security & Safety
    { phrases: ['security officer', 'safety officer', 'hse officer'], category: 'security_safety', title: 'security' },
    { phrases: ['health safety', 'environment safety', 'security guard'], category: 'security_safety', title: 'safety' },
    
    // Construction & Real Estate
    { phrases: ['construction manager', 'site supervisor', 'project supervisor'], category: 'construction_real_estate', title: 'construction' },
    { phrases: ['real estate', 'property manager', 'estate agent'], category: 'construction_real_estate', title: 'real estate' },
    { phrases: ['quantity surveyor', 'land surveyor', 'building engineer'], category: 'construction_real_estate', title: 'construction' },
    
    // Manufacturing & Production
    { phrases: ['production manager', 'factory manager', 'manufacturing engineer'], category: 'manufacturing_production', title: 'production' },
    { phrases: ['quality control', 'quality assurance', 'production supervisor'], category: 'manufacturing_production', title: 'manufacturing' },
    
    // Transport & Driving
    { phrases: ['truck driver', 'delivery driver', 'company driver'], category: 'transport_driving', title: 'driver' },
    { phrases: ['transport officer', 'logistics driver'], category: 'transport_driving', title: 'transport' },
    
    // Retail & Fashion
    { phrases: ['retail manager', 'store manager', 'sales assistant'], category: 'retail_fashion', title: 'retail' },
    { phrases: ['fashion designer', 'merchandiser'], category: 'retail_fashion', title: 'retail' }
  ];

  // Check exact phrases first (both original and filtered text)
  for (const group of exactPhrases) {
    for (const phrase of group.phrases) {
      const regex = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (regex.test(filteredText) || regex.test(lowerText)) {
        logger.info('Job detection - exact phrase match', {
          detectedPhrase: phrase,
          category: group.category,
          title: group.title,
          matchSource: regex.test(filteredText) ? 'filtered' : 'original'
        });
        
        return {
          category: group.category,
          rawTitle: group.title,
          detectedKeyword: phrase
        };
      }
    }
  }

  // PRIORITY LEVEL 2: Single high-value keywords with word boundaries
  const singleKeywords = [
    // IT & Software Development
    { keywords: ['developer', 'programmer', 'coding', 'programming'], category: 'it_software', title: 'developer' },
    { keywords: ['software', 'website', 'database', 'system'], category: 'it_software', title: 'IT' },
    
    // Accounting & Finance
    { keywords: ['accountant', 'accounting', 'bookkeeper', 'audit', 'auditor'], category: 'accounting_finance', title: 'accounting' },
    { keywords: ['finance', 'financial', 'treasury', 'budget'], category: 'accounting_finance', title: 'finance' },
    { keywords: ['cashier', 'teller', 'banker'], category: 'accounting_finance', title: 'banking' },
    
    // Sales & Marketing  
    { keywords: ['sales', 'selling'], category: 'marketing_sales', title: 'sales' },
    { keywords: ['marketing', 'advertisement', 'promotion'], category: 'marketing_sales', title: 'marketing' },
    
    // Healthcare & Medical
    { keywords: ['doctor', 'physician', 'medical'], category: 'healthcare_medical', title: 'medical' },
    { keywords: ['nurse', 'nursing'], category: 'healthcare_medical', title: 'nursing' },
    { keywords: ['pharmacist', 'pharmacy'], category: 'healthcare_medical', title: 'pharmacy' },
    { keywords: ['dentist', 'dental'], category: 'healthcare_medical', title: 'dental' },
    
    // Engineering & Technical
    { keywords: ['engineer', 'engineering'], category: 'engineering_technical', title: 'engineer' },
    { keywords: ['technician', 'technical', 'maintenance'], category: 'engineering_technical', title: 'technical' },
    
    // Education & Training
    { keywords: ['teacher', 'teaching', 'tutor', 'instructor'], category: 'education_training', title: 'teacher' },
    { keywords: ['lecturer', 'professor', 'education'], category: 'education_training', title: 'education' },
    { keywords: ['training', 'trainer'], category: 'education_training', title: 'training' },
    
    // Administration & Office
    { keywords: ['secretary', 'receptionist'], category: 'admin_office', title: 'administration' },
    { keywords: ['clerk', 'assistant'], category: 'admin_office', title: 'assistant' },
    { keywords: ['admin', 'administration', 'clerical'], category: 'admin_office', title: 'administration' },
    
    // Management & Executive
    { keywords: ['manager', 'management', 'supervisor'], category: 'management_executive', title: 'manager' },
    { keywords: ['director', 'executive', 'coordinator'], category: 'management_executive', title: 'management' },
    
    // Human Resources
    { keywords: ['recruitment', 'recruiter'], category: 'human_resources', title: 'recruitment' },
    { keywords: ['payroll'], category: 'human_resources', title: 'HR' },
    
    // Customer Service
    { keywords: ['representative', 'agent'], category: 'customer_service', title: 'customer service' },
    
    // Legal & Compliance
    { keywords: ['lawyer', 'attorney', 'barrister', 'solicitor'], category: 'legal_compliance', title: 'legal' },
    { keywords: ['legal', 'compliance'], category: 'legal_compliance', title: 'legal' },
    
    // Media & Creative
    { keywords: ['designer', 'design'], category: 'media_creative', title: 'designer' },
    { keywords: ['photographer', 'photography'], category: 'media_creative', title: 'creative' },
    { keywords: ['writer', 'editor', 'journalist'], category: 'media_creative', title: 'media' },
    { keywords: ['creative', 'artist'], category: 'media_creative', title: 'creative' },
    
    // Logistics & Supply Chain
    { keywords: ['logistics', 'warehouse', 'inventory'], category: 'logistics_supply', title: 'logistics' },
    { keywords: ['procurement', 'purchasing'], category: 'logistics_supply', title: 'procurement' },
    
    // Security & Safety
    { keywords: ['security', 'guard'], category: 'security_safety', title: 'security' },
    { keywords: ['safety'], category: 'security_safety', title: 'safety' },
    
    // Construction & Real Estate
    { keywords: ['construction', 'builder'], category: 'construction_real_estate', title: 'construction' },
    { keywords: ['architect', 'surveyor'], category: 'construction_real_estate', title: 'construction' },
    { keywords: ['property'], category: 'construction_real_estate', title: 'real estate' },
    
    // Manufacturing & Production
    { keywords: ['production', 'manufacturing'], category: 'manufacturing_production', title: 'production' },
    { keywords: ['factory', 'assembly'], category: 'manufacturing_production', title: 'manufacturing' },
    { keywords: ['operator'], category: 'manufacturing_production', title: 'production' },
    
    // Transport & Driving
    { keywords: ['driver', 'driving'], category: 'transport_driving', title: 'driver' },
    { keywords: ['transport', 'delivery'], category: 'transport_driving', title: 'transport' },
    
    // Retail & Fashion
    { keywords: ['retail', 'shop', 'store'], category: 'retail_fashion', title: 'retail' },
    { keywords: ['fashion'], category: 'retail_fashion', title: 'fashion' },
    
    // General Jobs
    { keywords: ['intern', 'trainee', 'graduate', 'entry'], category: 'other_general', title: 'entry level' },
    { keywords: ['officer', 'specialist'], category: 'other_general', title: 'officer' }
  ];

  // Check single keywords with word boundaries (filtered text first, then original)
  for (const group of singleKeywords) {
    for (const keyword of group.keywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(filteredText)) {
        logger.info('Job detection - single keyword match (filtered)', {
          detectedKeyword: keyword,
          category: group.category,
          title: group.title
        });
        
        return {
          category: group.category,
          rawTitle: group.title,
          detectedKeyword: keyword
        };
      }
    }
  }
  
  // Fallback to original text for single keywords
  for (const group of singleKeywords) {
    for (const keyword of group.keywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(lowerText)) {
        logger.info('Job detection - single keyword match (original)', {
          detectedKeyword: keyword,
          category: group.category,
          title: group.title
        });
        
        return {
          category: group.category,
          rawTitle: group.title,
          detectedKeyword: keyword
        };
      }
    }
  }

  // PRIORITY LEVEL 3: Substring matching as final fallback
  const substringKeywords = {
    // Only include very specific terms that won't cause false positives
    'account': 'accounting_finance',
    'market': 'marketing_sales', 
    'develop': 'it_software',
    'medic': 'healthcare_medical',
    'teach': 'education_training',
    'manage': 'management_executive',
    'secur': 'security_safety'
  };
  
  for (const [keyword, category] of Object.entries(substringKeywords)) {
    if (filteredText.includes(keyword)) {
      logger.info('Job detection - substring match', {
        detectedKeyword: keyword,
        category: category,
        matchType: 'substring'
      });
      
      return {
        category: category,
        rawTitle: keyword,
        detectedKeyword: keyword
      };
    }
  }

  logger.info('Job detection - no match found', {
    originalText: text,
    filteredText: filteredText
  });
  
  return null;
}
  // Extract the job title from user's message
  extractJobTitle(text, detectedKeyword = null) {
    const lowerText = text.toLowerCase();
    
    // Common job-related words to filter out
    const filterWords = ['jobs', 'job', 'work', 'find', 'looking', 'search', 'for', 'in', 'at', 'the', 'a', 'an'];
    
    // If we detected a specific keyword, use it
    if (detectedKeyword) {
      return detectedKeyword;
    }
    
    // Extract meaningful words from the message
    const words = text.toLowerCase().split(/\s+/)
      .filter(word => word.length > 2)
      .filter(word => !filterWords.includes(word))
      .filter(word => !this.isLocationWord(word));
    
    // Take the first 2-3 meaningful words as the job title
    return words.slice(0, 2).join(' ') || 'jobs';
  }

  isLocationWord(word) {
    return Object.keys(this.locations).some(location => location.includes(word));
  }

  // Get a random friendly search phrase
  getRandomSearchPhrase(jobType, location) {
    const phrases = this.searchPhrases;
    const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];
    return randomPhrase
      .replace('{jobType}', jobType)
      .replace('{location}', location);
  }

  async parseJobQuery(message, identifier = null, userContext = null) {
    this.metrics.totalRequests++;
    
    try {
      // LEVEL 1: Cache check (your existing logic)
      const cacheKey = this.getCacheKey(message);
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        this.metrics.cacheHits++;
        logger.info('Cache hit', { identifier });
        return cached;
      }

      // LEVEL 2: Simple commands (your existing logic)
      const simpleResult = this.parseSimpleCommand(message);
      if (simpleResult) {
        logger.info('Used local parsing', { identifier, action: simpleResult.action });
        this.setCache(cacheKey, simpleResult);
        return simpleResult;
      }

      // LEVEL 3: Enhanced Smart patterns
      const patternResult = this.parseSmartPatternsEnhanced(message, userContext);
      if (patternResult) {
        this.metrics.patternMatches++;
        logger.info('Smart pattern match', { identifier, action: patternResult.action });
        this.setCache(cacheKey, patternResult);
        return patternResult;
      }

      // LEVEL 4: Rate limiting (your existing logic)
     if (identifier) {
      const aiLimit = await RateLimiter.checkLimit(identifier, 'ai_call');
      if (!aiLimit.allowed) {
        return {
          action: 'rate_limited',
          response: aiLimit.message
        };
      }
    }
      // LEVEL 5: AI processing (your existing logic)
      this.metrics.aiCalls++;
      logger.info('Using AI for complex query', { identifier });
      const aiResult = await this.parseWithAI(message, identifier, userContext);
      this.setCache(cacheKey, aiResult);
      return aiResult;

    } catch (error) {
      logger.error('parseJobQuery error', { error: error.message, identifier });
      return {
        action: 'error',
        response: 'I can help you find jobs! Try "find jobs in Lagos" or "help" for commands.'
      };
    }
  }

  // ENHANCED: parseSmartPatterns with better detection and user-friendly responses
 // services/openai.js - MINIMAL pattern matching section only
// Replace your parseSmartPatternsEnhanced method with this:

parseSmartPatternsEnhanced(message, userContext = null) {
  const text = message.toLowerCase().trim();
  
  // Extract session data
  const sessionData = userContext?.sessionData || {};
  
  // ONLY HANDLE EXACT COMMANDS - Let AI handle everything else
  
  // 1. Exact "menu" command
  if (text === 'menu' || text === 'categories') {
    return {
      action: 'show_menu',
      response: 'Opening job categories menu...'
    };
  }
  
  // 2. Exact "status" command
  if (text === 'status') {
    return {
      action: 'status',
      response: 'Checking your status...'
    };
  }
  
  // 3. Exact "help" command
  if (text === 'help') {
    return {
      action: 'help',
      response: this.getHelpMessage()
    };
  }
  
  // 4. Show jobs command (multiple variations)
  const showJobsPatterns = [
    /^show\s*(job|jobs|jobz)$/i,
    /^(job|jobs|jobz)$/i,
    /^see\s*(job|jobs)$/i,
    /^view\s*(job|jobs)$/i,
    /^display\s*(job|jobs)$/i
  ];
  
  if (showJobsPatterns.some(pattern => pattern.test(text))) {
    return {
      action: 'show_jobs',
      response: 'Loading your jobs...'
    };
  }
  
  // 5. Apply patterns (exact job numbers or "all")
  if (/^apply\s+(\d+([,\s]+\d+)*|all)$/i.test(text) || 
      /^\d+([,\s]+\d+)*$/.test(text) ||
      /^(apply\s+)?all$/i.test(text)) {
    return {
      action: 'apply_job',
      response: 'Processing application...'
    };
  }
  
  // 6. CRITICAL: Job + Location detection (ONLY when BOTH are present)
  const jobDetection = this.detectJobTypeFromMessage(text);
  let detectedLocation = null;
  
  for (const [key, value] of Object.entries(this.locations)) {
    if (text.includes(key)) {
      detectedLocation = value;
      break;
    }
  }
  
  // ONLY return search_jobs if BOTH job AND location are clearly present
  if (jobDetection && detectedLocation) {
    const friendlyLabel = this.jobLabels[jobDetection.category] || jobDetection.rawTitle;
    
    return {
      action: 'search_jobs',
      response: this.getRandomSearchPhrase(friendlyLabel, detectedLocation),
      filters: {
        title: jobDetection.category,
        rawTitle: jobDetection.rawTitle,
        friendlyLabel: friendlyLabel,
        location: detectedLocation,
        remote: detectedLocation.toLowerCase() === 'remote'
      }
    };
  }
  
  // EVERYTHING ELSE goes to AI (including questions, partial queries, greetings)
  return null;
}
  // Your existing methods remain unchanged...
  async parseWithAI(message, identifier, userContext = null) {
    try {
      const jobId = `${identifier}-${Date.now()}`;
      
      const job = await openaiQueue.add(
        'parse-query',
        { 
          message,
          userId: identifier,
          userContext: userContext || {},
          timestamp: Date.now(),
          platform: userContext?.platform || 'whatsapp'
        },
        {
          jobId: jobId,
          attempts: 2,
          backoff: { type: 'exponential', delay: 1000 }
        }
      );

      logger.info('Job added to queue', { jobId: job.id });

      try {
        const result = await job.waitUntilFinished(queueEvents, 8000);
        
        if (result && (result.action || result.response)) {
          logger.info('AI result received', { jobId: job.id });
          return result;
        }
        
        throw new Error('Invalid AI response structure');
        
      } catch (waitError) {
        logger.warn('waitUntilFinished failed, trying Redis', { 
          error: waitError.message,
          jobId: job.id 
        });
        
        const delays = [100, 200, 400, 800, 1600];
        
        for (const delay of delays) {
          const resultStr = await redis.get(`job-result:${job.id}`);
          if (resultStr) {
            try {
              const result = JSON.parse(resultStr);
              await redis.del(`job-result:${job.id}`);
              logger.info('Got result from Redis fallback', { jobId: job.id });
              return result;
            } catch (parseError) {
              logger.error('Failed to parse Redis result', { error: parseError.message });
            }
          }
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        return this.generateIntelligentFallback(message);
      }

    } catch (error) {
      logger.error('AI parsing error', { error: error.message, identifier });
      return this.generateIntelligentFallback(message);
    }
  }

  // All other existing methods remain the same...
  getCacheKey(message) {
    return crypto.createHash('md5')
      .update(message.toLowerCase().trim())
      .digest('hex');
  }

  getFromCache(key) {
    const cached = this.queryCache.get(key);
    if (!cached) return null;
    
    if (Date.now() - cached.timestamp > this.cacheMaxAge) {
      this.queryCache.delete(key);
      return null;
    }
    
    return cached.data;
  }

  setCache(key, data) {
    if (this.queryCache.size >= this.cacheMaxSize) {
      const firstKey = this.queryCache.keys().next().value;
      this.queryCache.delete(firstKey);
    }
    
    this.queryCache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  cleanCache() {
    const now = Date.now();
    for (const [key, value] of this.queryCache.entries()) {
      if (now - value.timestamp > this.cacheMaxAge) {
        this.queryCache.delete(key);
      }
    }
  }

  generateIntelligentFallback(message) {
    const text = message.toLowerCase();
    
    if (text.match(/^(hello|hi|hey|good morning|good afternoon|good evening)/)) {
      return {
        action: 'greeting',
        response: 'Hello! Welcome to SmartCVNaija! 🇳🇬\n\nI help people find jobs in Nigeria. What type of work are you looking for?'
      };
    }
    
    if (text.includes('job') || text.includes('work') || text.includes('looking for')) {
      return {
        action: 'clarify',
        response: 'I can help you find jobs! Which city interests you?\n\n📍 Lagos\n📍 Abuja\n📍 Port Harcourt\n📍 Remote opportunities\n\nJust tell me what you\'re looking for!'
      };
    }
    
    return {
      action: 'help',
      response: '🆘 Quick Commands:\n\n• "find jobs in Lagos"\n• "remote developer jobs"\n• "apply 1,2,3" - Apply to jobs\n• "status" - Check your usage\n• Upload CV to get started!\n\nWhat would you like to do?'
    };
  }

  parseSimpleCommand(message) {
    const text = message.toLowerCase().trim();

    const commands = {
      'reset': { action: 'reset', response: 'Session cleared! Ready to start fresh! 🚀' },
      'clear': { action: 'reset', response: 'Session cleared! Ready to start fresh! 🚀' },
      'status': { action: 'status', response: 'Checking your status...' },
      'usage': { action: 'status', response: 'Checking your usage...' },
      'help': { action: 'help' },
      'commands': { action: 'help' },
      'start': { action: 'greeting' },
      'menu': { action: 'help' },
    };

    if (commands[text]) {
      return commands[text];
    }

    for (const [key, value] of Object.entries(commands)) {
      if (text.includes(key)) {
        return value;
      }
    }

    if (text.startsWith('apply ')) {
      if (text.includes('all')) {
        return { action: 'apply_job', applyAll: true, jobNumbers: null };
      }
      
      const numbers = this.extractJobNumbers(text);
      if (numbers.length > 0) {
        return { action: 'apply_job', applyAll: false, jobNumbers: numbers };
      }
    }

    if (text === 'next' || text === 'more') {
      return { action: 'browse_next' };
    }
    if (text === 'previous' || text === 'prev' || text === 'back') {
      return { action: 'browse_previous' };
    }

    return null;
  }

  extractJobNumbers(text) {
    const numbers = [];
    const matches = text.match(/\b\d+\b/g);
    
    if (matches) {
      matches.forEach(match => {
        const num = parseInt(match);
        if (num >= 1 && num <= 20) {
          numbers.push(num);
        }
      });
    }
    
    const commaMatch = text.match(/\d+(?:\s*,\s*\d+)*/);
    if (commaMatch) {
      const nums = commaMatch[0].split(',').map(n => parseInt(n.trim()));
      numbers.push(...nums.filter(n => n >= 1 && n <= 20));
    }
    
    return [...new Set(numbers)].sort((a, b) => a - b);
  }

  getHelpMessage() {
    return `🤖 **SmartCVNaija - Job Application Bot**

🔍 **Find Jobs:**
• "Find Developer & Engineering jobs in Lagos"
• "Remote Sales & Marketing jobs"
• "Jobs in Abuja"

💡 **How it works:**
1. Search for jobs (free preview)
2. Pay ₦300 to see full details
3. Select jobs to apply to
4. Upload CV for instant applications

📝 **Apply to Jobs:**
• Select jobs: "Apply to jobs 1,3,5"
• Apply to all: "Apply to all jobs"

📊 **Check Status:** Type "status"

🎯 **Simple Process:** Search → Pay → Select → Upload → Apply!`;
  }

  async generateCoverLetter(cvText, jobTitle = null, companyName = null, applicantName = null, identifier = null) {
      const startTime = Date.now();
      
      try {
        const job = await openaiQueue.add(
          'generate-cover-letter',
          { 
            cvText, 
            jobTitle, 
            companyName, 
            applicantName: applicantName || '[Your Name]',
            userId: identifier 
          },
          { 
            jobId: `cover-${identifier || 'anon'}-${Date.now()}`,
            attempts: 1,
            ttl: 15000,
            removeOnFail: true,
            removeOnComplete: true
          }
        );
        
        try {
          // FIXED: Updated timeout to 65000
          const result = await job.waitUntilFinished(queueEvents, 65000);
          const duration = Date.now() - startTime;
          
          // FIXED: Lowered validation threshold from 100 to 50 characters
          if (typeof result === 'string' && result.length > 50) {
            logger.info('Cover letter generated via AI', {
              identifier: identifier?.substring(0, 6) + '***',
              duration: `${duration}ms`,
              letterLength: result.length,
              source: 'AI'
            });
            return result;
          }
          
          if (result?.content && result.content.length > 50) {
            logger.info('Cover letter generated via AI (nested)', {
              identifier: identifier?.substring(0, 6) + '***',
              duration: `${duration}ms`,
              letterLength: result.content.length,
              source: 'AI'
            });
            return result.content;
          }
          
          throw new Error('AI returned insufficient content');
          
        } catch (waitError) {
          const duration = Date.now() - startTime;
          logger.warn('Cover letter generation timeout - using fallback', {
            identifier: identifier?.substring(0, 6) + '***',
            duration: `${duration}ms`,
            error: waitError.message,
            source: 'Fallback'
          });
          
          try {
            await job.remove();
          } catch (cleanupError) {
            // Ignore cleanup errors
          }
          
          return this.getEnhancedFallbackCoverLetter(cvText, jobTitle, companyName, applicantName);
        }
        
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error('Cover letter generation failed completely', {
          identifier: identifier?.substring(0, 6) + '***',
          duration: `${duration}ms`,
          error: error.message,
          source: 'Fallback'
        });
        
        return this.getEnhancedFallbackCoverLetter(cvText, jobTitle, companyName, applicantName);
      }
    }
  async extractUserInfo(cvText, identifier) {
    try {
      const job = await openaiQueue.add(
        'extract-user-info',
        { 
          cvText, 
          identifier 
        },
        { 
          jobId: `extract-${identifier || 'anon'}-${Date.now()}`,
          attempts: 2,
          ttl: 30000,
          removeOnFail: true,
          removeOnComplete: true
        }
      );
      
      const result = await job.waitUntilFinished(queueEvents, 35000);
      
      if (result && result.name) {
        logger.info('User info extracted via AI', {
          identifier: identifier?.substring(0, 6) + '***',
          name: result.name,
          source: 'AI'
        });
        return result;
      }
      
      throw new Error('AI extraction returned invalid result');
      
    } catch (error) {
      logger.error('AI user info extraction failed in service', {
        identifier: identifier?.substring(0, 6) + '***',
        error: error.message
      });
      throw error;
    }
  }
  
  // FIXED: Added all missing validation methods
  cleanAndValidateName(name) {
    if (!name || typeof name !== 'string') return '';
  
    const cleaned = name
        .replace(/[^\w\s\-'.]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      if (cleaned.length >= 4 && cleaned.length <= 50) {
        const words = cleaned.split(' ').filter(word => word.length > 1);
        
        if (words.length >= 2) {
          const badWords = ['experience', 'team', 'leadership', 'skills', 'cv', 'resume', 'information'];
          const hasBadWords = words.some(word => 
            badWords.includes(word.toLowerCase())
          );
          
          if (!hasBadWords) {
            return cleaned;
          }
        }
      }
      
      return '';
    }
  
    cleanAndValidateEmail(email) {
      if (!email || typeof email !== 'string') return '';
      
      const cleaned = email.trim().toLowerCase();
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      
      if (emailRegex.test(cleaned)) {
        const badDomains = ['example.com', 'test.com', 'smartcvnaija.com'];
        const domain = cleaned.split('@')[1];
        
        if (!badDomains.includes(domain)) {
          return cleaned;
        }
      }
      
      return '';
    }
  
    cleanAndValidatePhone(phone, identifier) {
      if (!phone || typeof phone !== 'string') return identifier;
      
      const cleaned = phone.replace(/[^\d+]/g, '');
      const patterns = [
        /^(\+234|234)\d{10}$/,
        /^0\d{10}$/
      ];
      
      if (patterns.some(pattern => pattern.test(cleaned))) {
        return cleaned;
      }
      
      return identifier;
    }
  
    // Enhanced fallback methods from your original code
    getEnhancedFallbackCoverLetter(cvText, jobTitle, companyName, applicantName = '[Your Name]') {
      try {
        const cvInfo = this.extractBasicCVInfo(cvText || '');
        const jobSpecific = this.getJobSpecificContent(jobTitle, cvInfo);
        
        return `Dear Hiring Manager,
  
  I am writing to express my strong interest in the ${jobTitle || 'position'} at ${companyName || 'your company'}. ${jobSpecific.opening}
  
  ${cvInfo.experienceText} ${jobSpecific.skills} ${cvInfo.skillsText}
  
  I would welcome the opportunity to discuss how my background can contribute to your team's success. Thank you for considering my application, and I look forward to hearing from you.
  
  Best regards,
  ${applicantName}`;
      } catch (error) {
        logger.error('Enhanced fallback failed, using basic template', { error: error.message });
        return this.getFallbackCoverLetter(jobTitle, companyName, applicantName);
      }
    }
  
    extractBasicCVInfo(cvText) {
      const text = cvText.toLowerCase();
      
      let education = '';
      if (text.includes('bachelor') || text.includes('bsc') || text.includes('b.sc')) {
        education = 'bachelor\'s degree';
      } else if (text.includes('master') || text.includes('msc') || text.includes('m.sc')) {
        education = 'master\'s degree';
      } else if (text.includes('hnd') || text.includes('diploma')) {
        education = 'diploma';
      } else if (text.includes('university') || text.includes('college')) {
        education = 'university education';
      }
  
      let yearsExp = '';
      const yearMatches = text.match(/(\d+)\s*years?\s*(of\s*)?(experience|exp)/);
      if (yearMatches) {
        yearsExp = `${yearMatches[1]} years of experience`;
      } else if (text.includes('experienced') || text.includes('experience')) {
        yearsExp = 'relevant experience';
      }
  
      const skills = [];
      const skillKeywords = ['excel', 'microsoft office', 'accounting software', 'quickbooks', 'sap', 'sql', 'javascript', 'python', 'photoshop', 'autocad', 'project management'];
      skillKeywords.forEach(skill => {
        if (text.includes(skill)) {
          skills.push(skill);
        }
      });
  
      let experienceText = '';
      if (education && yearsExp) {
        experienceText = `With my ${education} and ${yearsExp}, I am well-positioned for this role.`;
      } else if (education) {
        experienceText = `My ${education} has provided me with a strong foundation for this position.`;
      } else if (yearsExp) {
        experienceText = `My ${yearsExp} has prepared me well for this opportunity.`;
      } else {
        experienceText = 'My professional background has equipped me with relevant skills for this position.';
      }
  
      let skillsText = '';
      if (skills.length > 0) {
        const skillsList = skills.slice(0, 3).join(', ');
        skillsText = `My proficiency in ${skillsList} aligns well with your requirements.`;
      }
  
      return {
        education,
        yearsExp,
        skills,
        experienceText,
        skillsText
      };
    }
  
    getJobSpecificContent(jobTitle, cvInfo) {
      const title = (jobTitle || '').toLowerCase();
      
      if (title.includes('account') || title.includes('finance')) {
        return {
          opening: `My background in accounting and financial management, combined with ${cvInfo.experienceText ? 'my professional experience' : 'my educational foundation'}, makes me well-suited for this role.`,
          skills: 'My understanding of financial processes and attention to detail position me well for this accounting role.'
        };
      } else if (title.includes('developer') || title.includes('software') || title.includes('it')) {
        return {
          opening: 'My technical background and passion for technology make me an ideal candidate for this development position.',
          skills: 'My programming knowledge and problem-solving abilities align with your technical requirements.'
        };
      } else if (title.includes('marketing') || title.includes('sales')) {
        return {
          opening: 'My experience in client relations and understanding of market dynamics prepare me well for this marketing role.',
          skills: 'My communication skills and market awareness make me a strong candidate for your sales team.'
        };
      } else if (title.includes('manager') || title.includes('supervisor')) {
        return {
          opening: 'My leadership capabilities and management experience make me well-qualified for this supervisory position.',
          skills: 'My ability to coordinate teams and manage projects effectively suits your management requirements.'
        };
      }
      
      return {
        opening: `My professional background and ${cvInfo.education || 'educational foundation'} make me a qualified candidate for this role.`,
        skills: 'My relevant skills and dedication to excellence position me well for this opportunity.'
      };
    }
  
    getFallbackCoverLetter(jobTitle = null, companyName = null, applicantName = '[Your Name]') {
      return `Dear Hiring Manager,
  
  I am writing to express my strong interest in the ${jobTitle || 'position'} at ${companyName || 'your company'}.
  
  My background and experience make me a qualified candidate for this role in Nigeria's competitive market. I have developed strong skills that align with your requirements and am confident in my ability to contribute to your team.
  
  I would welcome the opportunity to discuss how my experience can benefit your organization. Thank you for considering my application.
  
  Best regards,
  ${applicantName}`;
    }
  
    getRandomSearchPhrase(jobType, location) {
      const phrase = this.searchPhrases[Math.floor(Math.random() * this.searchPhrases.length)];
      return phrase.replace('{jobType}', jobType).replace('{location}', location);
    }
   logMetrics() {
      try {
        logger.info('AIService metrics', {
          cacheSize: this.queryCache.size,
          cacheHits: this.metrics.cacheHits,
          patternMatches: this.metrics.patternMatches,
          aiCalls: this.metrics.aiCalls,
          totalRequests: this.metrics.totalRequests,
          cacheHitRate: this.metrics.totalRequests > 0 
            ? ((this.metrics.cacheHits / this.metrics.totalRequests) * 100).toFixed(2) + '%'
            : '0%',
          aiCallRate: this.metrics.totalRequests > 0 
            ? ((this.metrics.aiCalls / this.metrics.totalRequests) * 100).toFixed(2) + '%'
            : '0%'
        });
      } catch (error) {
        logger.error('Failed to log metrics', { error: error.message });
      }
    }
    // NEW: Method to clear session data for testing
    async clearSessionData(identifier) {
      if (identifier) {
        try {
          await sessionRedis.del(`session:${identifier}`);
          logger.info('Session data cleared', { identifier });
          return true;
        } catch (error) {
          logger.error('Failed to clear session data', { identifier, error: error.message });
          return false;
        }
      }
      return false;
    }
  }
  
  module.exports = new AIService();