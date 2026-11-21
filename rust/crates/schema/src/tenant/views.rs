//! The tenant database's views. They have no entity: their columns are
//! query expressions, typed by the database.

#[allow(unused_imports)]
use crate::ddl::View;

/// Every view, in name order.
pub const VIEWS: &[View] = &[
    View {
        name: "mv_crm_activities_daily",
        definition: "select DATE_TRUNC('day', \"created_at\") as \"period\", \"type\", \"status\", \"related_to\", \"call_direction\", COUNT(*) as \"activity_count\", COUNT(*) FILTER (WHERE \"status\" = 'completed') as \"completed_count\", AVG(\"duration\") FILTER (WHERE \"duration\" IS NOT NULL) as \"avg_duration\", SUM(\"duration\") FILTER (WHERE \"duration\" IS NOT NULL) as \"total_duration\", AVG(\"call_duration\") FILTER (WHERE \"call_duration\" IS NOT NULL) as \"avg_call_duration\", SUM(\"call_duration\") FILTER (WHERE \"call_duration\" IS NOT NULL) as \"total_call_duration\", COUNT(*) FILTER (WHERE \"call_direction\" = 'inbound') as \"inbound_calls\", COUNT(*) FILTER (WHERE \"call_direction\" = 'outbound') as \"outbound_calls\" from \"crm_activities\" where \"crm_activities\".\"deleted_at\" IS NULL group by DATE_TRUNC('day', \"crm_activities\".\"created_at\"), \"crm_activities\".\"type\", \"crm_activities\".\"status\", \"crm_activities\".\"related_to\", \"crm_activities\".\"call_direction\"",
        materialized: true,
        with_no_data: true,
        columns_json: "{\"type\":{\"name\":\"type\",\"type\":\"varchar(30)\",\"primaryKey\":false,\"notNull\":true},\"status\":{\"name\":\"status\",\"type\":\"varchar(20)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'planned'\"},\"related_to\":{\"name\":\"related_to\",\"type\":\"varchar(20)\",\"primaryKey\":false,\"notNull\":false},\"call_direction\":{\"name\":\"call_direction\",\"type\":\"varchar(10)\",\"primaryKey\":false,\"notNull\":false}}",
    },
    View {
        name: "mv_crm_leads_daily",
        definition: "select DATE_TRUNC('day', \"created_at\") as \"period\", \"status\", \"source\", \"rating\", COUNT(*) as \"lead_count\", COUNT(*) FILTER (WHERE \"is_qualified\" = true) as \"qualified_count\", COUNT(*) FILTER (WHERE \"converted_at\" IS NOT NULL) as \"converted_count\", AVG(\"score\") as \"avg_score\", AVG(EXTRACT(EPOCH FROM (\"converted_at\" - \"created_at\")) / 3600) FILTER (WHERE \"converted_at\" IS NOT NULL) as \"avg_time_to_convert\", AVG(EXTRACT(EPOCH FROM (\"qualified_at\" - \"created_at\")) / 3600) FILTER (WHERE \"qualified_at\" IS NOT NULL) as \"avg_time_to_qualify\", AVG(EXTRACT(EPOCH FROM (\"first_response_at\" - \"created_at\")) / 3600) FILTER (WHERE \"first_response_at\" IS NOT NULL) as \"avg_time_to_first_response\" from \"crm_leads\" where \"crm_leads\".\"deleted_at\" IS NULL group by DATE_TRUNC('day', \"crm_leads\".\"created_at\"), \"crm_leads\".\"status\", \"crm_leads\".\"source\", \"crm_leads\".\"rating\"",
        materialized: true,
        with_no_data: true,
        columns_json: "{\"status\":{\"name\":\"status\",\"type\":\"varchar(20)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'new'\"},\"source\":{\"name\":\"source\",\"type\":\"varchar(50)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'other'\"},\"rating\":{\"name\":\"rating\",\"type\":\"varchar(10)\",\"primaryKey\":false,\"notNull\":false}}",
    },
    View {
        name: "mv_crm_opportunities_daily",
        definition: "select DATE_TRUNC('day', \"created_at\") as \"period\", \"stage\", \"status\", \"forecast_category\", \"risk_level\", COUNT(*) as \"opportunity_count\", COUNT(*) FILTER (WHERE \"status\" = 'won') as \"won_count\", COUNT(*) FILTER (WHERE \"status\" = 'lost') as \"lost_count\", SUM(\"amount\") as \"total_amount\", AVG(\"amount\") as \"avg_amount\", SUM(\"amount\" * \"probability\" / 100) as \"weighted_amount\", SUM(\"amount\") FILTER (WHERE \"status\" = 'won') as \"won_amount\", SUM(\"amount\") FILTER (WHERE \"status\" = 'lost') as \"lost_amount\", AVG(\"probability\") as \"avg_probability\", AVG(\"days_in_current_stage\") as \"avg_days_in_stage\" from \"crm_opportunities\" where \"crm_opportunities\".\"deleted_at\" IS NULL group by DATE_TRUNC('day', \"crm_opportunities\".\"created_at\"), \"crm_opportunities\".\"stage\", \"crm_opportunities\".\"status\", \"crm_opportunities\".\"forecast_category\", \"crm_opportunities\".\"risk_level\"",
        materialized: true,
        with_no_data: true,
        columns_json: "{\"stage\":{\"name\":\"stage\",\"type\":\"varchar(50)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'prospecting'\"},\"status\":{\"name\":\"status\",\"type\":\"varchar(20)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'open'\"},\"forecast_category\":{\"name\":\"forecast_category\",\"type\":\"varchar(20)\",\"primaryKey\":false,\"notNull\":false},\"risk_level\":{\"name\":\"risk_level\",\"type\":\"varchar(10)\",\"primaryKey\":false,\"notNull\":false}}",
    },
    View {
        name: "mv_helpdesk_agent_stats",
        definition: "select \"id\", \"name\", \"status\", \"tickets_resolved\", \"tickets_assigned\", \"average_response_time\", \"satisfaction_score\" from \"helpdesk_agents\" where \"helpdesk_agents\".\"deleted_at\" IS NULL",
        materialized: true,
        with_no_data: true,
        columns_json: "{\"id\":{\"name\":\"id\",\"type\":\"varchar(30)\",\"primaryKey\":true,\"notNull\":true},\"name\":{\"name\":\"name\",\"type\":\"varchar(255)\",\"primaryKey\":false,\"notNull\":true},\"status\":{\"name\":\"status\",\"type\":\"varchar(20)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'active'\"},\"tickets_resolved\":{\"name\":\"tickets_resolved\",\"type\":\"integer\",\"primaryKey\":false,\"notNull\":false,\"default\":0},\"tickets_assigned\":{\"name\":\"tickets_assigned\",\"type\":\"integer\",\"primaryKey\":false,\"notNull\":false,\"default\":0},\"average_response_time\":{\"name\":\"average_response_time\",\"type\":\"integer\",\"primaryKey\":false,\"notNull\":false},\"satisfaction_score\":{\"name\":\"satisfaction_score\",\"type\":\"numeric(3, 2)\",\"primaryKey\":false,\"notNull\":false}}",
    },
    View {
        name: "mv_helpdesk_conversations_daily",
        definition: "select DATE_TRUNC('day', \"created_at\") as \"period\", \"status\", \"channel\", COUNT(*) as \"conversation_count\", AVG(\"message_count\") as \"avg_messages\" from \"helpdesk_conversations\" where \"helpdesk_conversations\".\"deleted_at\" IS NULL group by DATE_TRUNC('day', \"helpdesk_conversations\".\"created_at\"), \"helpdesk_conversations\".\"status\", \"helpdesk_conversations\".\"channel\"",
        materialized: true,
        with_no_data: true,
        columns_json: "{\"status\":{\"name\":\"status\",\"type\":\"varchar(20)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'active'\"},\"channel\":{\"name\":\"channel\",\"type\":\"varchar(20)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'web'\"}}",
    },
    View {
        name: "mv_helpdesk_satisfaction_daily",
        definition: "select DATE_TRUNC('day', \"sent_at\") as \"period\", COUNT(*) as \"survey_count\", COUNT(*) FILTER (WHERE \"status\" = 'completed') as \"completed_count\", AVG(\"rating\") FILTER (WHERE \"status\" = 'completed') as \"avg_rating\", COUNT(*) FILTER (WHERE \"rating\" >= 9) as \"promoters\", COUNT(*) FILTER (WHERE \"rating\" <= 6) as \"detractors\" from \"helpdesk_satisfaction_surveys\" where \"helpdesk_satisfaction_surveys\".\"deleted_at\" IS NULL group by DATE_TRUNC('day', \"helpdesk_satisfaction_surveys\".\"sent_at\")",
        materialized: true,
        with_no_data: true,
        columns_json: "{}",
    },
    View {
        name: "mv_helpdesk_tickets_daily",
        definition: "select DATE_TRUNC('day', \"created_at\") as \"period\", \"status\", \"priority\", \"channel\", COUNT(*) as \"ticket_count\", COUNT(*) FILTER (WHERE \"is_escalated\" = true) as \"escalated_count\", AVG(\"response_time\") FILTER (WHERE \"response_time\" IS NOT NULL) as \"avg_response_time\", AVG(\"resolution_time\") FILTER (WHERE \"resolution_time\" IS NOT NULL) as \"avg_resolution_time\" from \"helpdesk_tickets\" where \"helpdesk_tickets\".\"deleted_at\" IS NULL group by DATE_TRUNC('day', \"helpdesk_tickets\".\"created_at\"), \"helpdesk_tickets\".\"status\", \"helpdesk_tickets\".\"priority\", \"helpdesk_tickets\".\"channel\"",
        materialized: true,
        with_no_data: true,
        columns_json: "{\"status\":{\"name\":\"status\",\"type\":\"varchar(20)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'new'\"},\"priority\":{\"name\":\"priority\",\"type\":\"varchar(20)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'medium'\"},\"channel\":{\"name\":\"channel\",\"type\":\"varchar(20)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'web'\"}}",
    },
    View {
        name: "mv_milestone_stats",
        definition: "select \"project_id\", \"id\", \"name\", \"status\", \"due_date\", \"completed_at\", \"progress\", \"completed_tasks\", \"total_tasks\", CASE WHEN \"due_date\" < NOW() AND \"status\" != 'completed' THEN true ELSE false END as \"is_overdue\", CASE WHEN \"completed_at\" IS NOT NULL AND \"completed_at\" <= \"due_date\" THEN true ELSE false END as \"is_on_time\", \"is_key_milestone\" from \"milestones\" where \"milestones\".\"deleted_at\" IS NULL",
        materialized: true,
        with_no_data: true,
        columns_json: "{\"project_id\":{\"name\":\"project_id\",\"type\":\"varchar(255)\",\"primaryKey\":false,\"notNull\":true},\"id\":{\"name\":\"id\",\"type\":\"varchar(255)\",\"primaryKey\":true,\"notNull\":true},\"name\":{\"name\":\"name\",\"type\":\"varchar(255)\",\"primaryKey\":false,\"notNull\":true},\"status\":{\"name\":\"status\",\"type\":\"varchar(50)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'pending'\"},\"due_date\":{\"name\":\"due_date\",\"type\":\"timestamp\",\"primaryKey\":false,\"notNull\":true},\"completed_at\":{\"name\":\"completed_at\",\"type\":\"timestamp\",\"primaryKey\":false,\"notNull\":false},\"progress\":{\"name\":\"progress\",\"type\":\"numeric(5, 2)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'0'\"},\"completed_tasks\":{\"name\":\"completed_tasks\",\"type\":\"integer\",\"primaryKey\":false,\"notNull\":false,\"default\":0},\"total_tasks\":{\"name\":\"total_tasks\",\"type\":\"integer\",\"primaryKey\":false,\"notNull\":false,\"default\":0},\"is_key_milestone\":{\"name\":\"is_key_milestone\",\"type\":\"boolean\",\"primaryKey\":false,\"notNull\":false,\"default\":false}}",
    },
    View {
        name: "mv_projects_summary_daily",
        definition: "select DATE_TRUNC('day', \"created_at\") as \"period\", \"id\", \"status\", \"health\", COUNT(*) as \"project_count\", COUNT(*) FILTER (WHERE \"is_active\" = true) as \"active_count\", SUM(\"budgeted_hours\") as \"total_budgeted_hours\", SUM(\"actual_hours\") as \"total_actual_hours\", SUM(\"budgeted_amount\") as \"total_budgeted_amount\", SUM(\"actual_amount\") as \"total_actual_amount\", AVG(\"progress\") as \"avg_progress\", SUM(\"total_tasks\") as \"total_tasks\", SUM(\"completed_tasks\") as \"completed_tasks\", SUM(\"total_milestones\") as \"total_milestones\", SUM(\"completed_milestones\") as \"completed_milestones\" from \"projects\" where \"projects\".\"deleted_at\" IS NULL group by DATE_TRUNC('day', \"projects\".\"created_at\"), \"projects\".\"id\", \"projects\".\"status\", \"projects\".\"health\"",
        materialized: true,
        with_no_data: true,
        columns_json: "{\"id\":{\"name\":\"id\",\"type\":\"varchar(255)\",\"primaryKey\":true,\"notNull\":true},\"status\":{\"name\":\"status\",\"type\":\"varchar(50)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'Planning'\"},\"health\":{\"name\":\"health\",\"type\":\"varchar(50)\",\"primaryKey\":false,\"notNull\":false}}",
    },
    View {
        name: "mv_tasks_daily",
        definition: "select DATE_TRUNC('day', \"created_at\") as \"period\", \"project_id\", \"status\", \"priority\", \"type\", COUNT(*) as \"task_count\", COUNT(*) FILTER (WHERE \"status\" = 'done') as \"completed_count\", COUNT(*) FILTER (WHERE \"due_date\" < NOW() AND \"status\" != 'done' AND \"status\" != 'cancelled') as \"overdue_count\", SUM(\"estimated_hours\") as \"total_estimated_hours\", SUM(\"actual_hours\") as \"total_actual_hours\", AVG(\"progress\") as \"avg_progress\" from \"tasks\" where \"tasks\".\"deleted_at\" IS NULL group by DATE_TRUNC('day', \"tasks\".\"created_at\"), \"tasks\".\"project_id\", \"tasks\".\"status\", \"tasks\".\"priority\", \"tasks\".\"type\"",
        materialized: true,
        with_no_data: true,
        columns_json: "{\"project_id\":{\"name\":\"project_id\",\"type\":\"varchar(255)\",\"primaryKey\":false,\"notNull\":false},\"status\":{\"name\":\"status\",\"type\":\"varchar(50)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'todo'\"},\"priority\":{\"name\":\"priority\",\"type\":\"varchar(20)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'medium'\"},\"type\":{\"name\":\"type\",\"type\":\"varchar(50)\",\"primaryKey\":false,\"notNull\":false,\"default\":\"'task'\"}}",
    },
    View {
        name: "mv_time_entries_daily",
        definition: "select DATE_TRUNC('day', \"date\"::timestamp) as \"period\", \"project_id\", \"user_id\", \"status\", COUNT(*) as \"entry_count\", SUM(\"duration\") as \"total_duration\", SUM(\"duration\") FILTER (WHERE \"billable\" = true) as \"billable_duration\", SUM(\"duration\") FILTER (WHERE \"billable\" = false) as \"non_billable_duration\", SUM(\"cost\") as \"total_cost\", AVG(\"rate\") FILTER (WHERE \"rate\" IS NOT NULL) as \"avg_rate\" from \"time_entries\" where \"time_entries\".\"deleted_at\" IS NULL group by DATE_TRUNC('day', \"time_entries\".\"date\"::timestamp), \"time_entries\".\"project_id\", \"time_entries\".\"user_id\", \"time_entries\".\"status\"",
        materialized: true,
        with_no_data: true,
        columns_json: "{\"project_id\":{\"name\":\"project_id\",\"type\":\"varchar(255)\",\"primaryKey\":false,\"notNull\":false},\"user_id\":{\"name\":\"user_id\",\"type\":\"varchar(255)\",\"primaryKey\":false,\"notNull\":true},\"status\":{\"name\":\"status\",\"type\":\"varchar(50)\",\"primaryKey\":false,\"notNull\":true,\"default\":\"'draft'\"}}",
    },
];
